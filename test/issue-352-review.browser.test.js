import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test(
  "352 stale history retains the accepted plus-sign alias, author query and fragment",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-352-history-"));
    const entry = path.join(temp, "entry.html");
    const port = await freePort();
    const env = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-history-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const cli = path.join(repoRoot, "dist", "cli.mjs");
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    try {
      await writeFile(
        entry,
        '<!doctype html><body><a href="alias+review.html?view=review&view=full#target">Open history target</a></body>',
      );
      await writeFile(
        path.join(temp, "a.html"),
        `<!doctype html><body><p id="target">Historical alias target</p><button onclick="history.pushState(null,'','#pushed')">Push view</button><button onclick="history.replaceState(null,'','#replaced')">Replace view</button><a href="b.html">Next document</a>
        <script>addEventListener('message', e => {
          if (e.data === 'test-history-hide') {
            dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
            parent.postMessage('test-history-hidden', '*');
          }
          if (e.data === 'test-history-show') dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
        });</script></body>`,
      );
      await writeFile(path.join(temp, "b.html"), "<!doctype html><body><p>Second document</p></body>");
      await symlink("a.html", path.join(temp, "alias+review.html"));
      const opened = run(process.execPath, [cli, entry, "--no-open"], env);
      const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, opened);
      browser("open", url);
      const evalChrome = (source) => browser("eval", source);
      await eventually(
        async () => evalChrome("() => Boolean(currentArtifactBinding)"),
        (text) => /true/.test(text),
        "entry did not bind",
      );
      evalChrome(
        '() => { annotation = false; postToFrame({type:"lavish:setAnnotationMode",enabled:false}); return true; }',
      );
      // A ref goes stale when the chrome DOM mutates between the snapshot and the click
      // (the layout gate settling, presence updates), so re-snapshot and retry like 352-B01.
      const click = (label) => {
        let staleError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const line = browser("snapshot")
            .split("\n")
            .find((line) => line.includes(label));
          assert.ok(line, label);
          try {
            browser("click", "@" + line.trim().split(/\s+/)[0].replace(/^uid=/, ""));
            return;
          } catch (error) {
            if (!/STALE_REF|Stale ref/.test(String(error?.message || error))) throw error;
            staleError = error;
          }
        }
        throw staleError;
      };
      click("Open history target");
      await eventually(
        async () =>
          evalChrome(
            '() => Array.from(historicalDestinations.values()).some(r => r.url.endsWith("alias+review.html?view=review&view=full#target"))',
          ),
        (text) => /true/.test(text),
        "alias receipt was not retained",
      );
      for (const [label, fragment] of [
        ["Push view", "pushed"],
        ["Replace view", "replaced"],
      ]) {
        if (fragment === "replaced")
          evalChrome(`() => {
          window.__delayedHistoryDocument = currentArtifactBinding.documentId;
          const original = window.fetch;
          window.fetch = async function(url, init) {
            const response = await original.apply(this, arguments);
            if (!window.__delayedHistorySigned && String(url).includes('/artifact-bindings/validate') && JSON.parse(init.body).destination?.url.endsWith('#replaced')) {
              window.__delayedHistorySigned = response.ok;
              await new Promise(resolve => { window.__releaseHistoryReceipt = resolve; });
            }
            return response;
          };
          return true;
        }`);
        click(label);
        if (fragment === "replaced") {
          await eventually(
            async () => evalChrome("() => window.__delayedHistorySigned"),
            (text) => /true/.test(text),
            "receipt was not signed before navigation",
          );
          continue;
        }
        await eventually(
          async () =>
            evalChrome(
              `() => Array.from(historicalDestinations.values()).some(r => r.url.endsWith("alias+review.html?view=review&view=full#${fragment}"))`,
            ),
          (text) => /true/.test(text),
          `successful ${label} did not get a destination receipt`,
        );
      }
      click("Next document");
      await eventually(
        async () => evalChrome("() => currentArtifactBinding?.page"),
        (text) => text.includes("b.html"),
        "second page did not bind",
      );
      evalChrome("() => { window.__releaseHistoryReceipt(); return true; }");
      await eventually(
        async () =>
          evalChrome(
            "() => Array.from(historicalDestinations.values()).some(r => r.document_id === window.__delayedHistoryDocument && r.url.endsWith('#replaced'))",
          ),
        (text) => /true/.test(text),
        "delayed A receipt was lost after B authenticated",
      );
      assert.match(evalChrome("() => currentArtifactBinding.page"), /b.html/);
      evalChrome("() => { reloadArtifact(); return true; }");
      await eventually(
        async () => evalChrome("() => currentArtifactBinding?.page"),
        (text) => text.includes("b.html"),
        "second page reload did not bind",
      );
      evalChrome(`() => {
        window.__historyRecoveryRequests = [];
        window.__historyValidation = [];
        const original = window.fetch;
        window.fetch = function(url, init) {
          if (String(url).includes('/artifact-loads/begin') && init?.body) {
            const body = JSON.parse(init.body);
            if (body.historical_page) window.__historyRecoveryRequests.push(body.historical_page);
          }
          const result = original.apply(this, arguments);
          if (String(url).includes('/artifact-bindings/validate')) result.then(r => r.clone().text().then(text => window.__historyValidation.push({input:JSON.parse(init.body),status:r.status,text})));
          return result;
        };
        return true;
      }`);
      browser("back");
      await eventually(
        async () => evalChrome("() => currentArtifactBinding?.destination"),
        (text) => text.includes("alias+review.html?view=review&view=full#replaced"),
        "Back lost the exact historical destination",
      );
      assert.match(browser("snapshot"), /Historical alias target/);
      // Chromium may refetch instead of using BFCache for subframe Back. Exercise
      // the persisted lifecycle explicitly too, keeping the actual SDK document.
      evalChrome(`() => {
        window.__historyHidden = false;
        window.addEventListener('message', e => { if (e.source === frame.contentWindow && e.data === 'test-history-hidden') window.__historyHidden = true; });
        frame.contentWindow.postMessage('test-history-hide', '*');
        return true;
      }`);
      await eventually(
        async () => evalChrome("() => window.__historyHidden"),
        (text) => /result:\s*"true"/.test(text),
        "SDK document did not receive pagehide",
      );
      assert.match(
        evalChrome(`async () => {
        const response = await fetch('/api/' + key + '/artifact-loads/begin', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({request_id:'browser-stale-history', request_sequence: ++artifactLoadRequestSequence,
            chrome_load_token:chromeLoadToken})
        });
        if (!response.ok) throw new Error('generation advance failed');
        const load = await response.json();
        artifactLoadRevision = load.artifact_revision;
        artifactLoadToken = load.artifact_load_token;
        retireArtifactBinding();
        frame.contentWindow.postMessage('test-history-show', '*');
        return true;
      }`),
        /result:\s*"true"/,
      );
      try {
        await eventually(
          async () =>
            evalChrome(
              "() => window.__historyRecoveryRequests.length > 0 && currentArtifactBinding?.destination.endsWith('alias+review.html?view=review&view=full#replaced')",
            ),
          (text) => /result:\s*"true"/.test(text),
          "stale historical document did not recover through its receipt",
        );
      } catch (error) {
        assert.fail(
          String(error) +
            evalChrome(
              "() => JSON.stringify({binding:currentArtifactBinding && {id:currentArtifactBinding.documentId,token:currentArtifactBinding.token,url:currentArtifactBinding.destination},token:artifactLoadToken,ready:latestReadyDocumentId,attempt:artifactChallengeAttempt?.documentId,requests:window.__historyRecoveryRequests,validation:window.__historyValidation})",
            ),
        );
      }
      assert.match(
        evalChrome(
          "() => currentArtifactBinding.token === artifactLoadToken && currentArtifactBinding.revision === artifactLoadRevision",
        ),
        /true/,
      );
    } finally {
      cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], env);
      cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "352 real SDK fatal failures on A then B deliver separate flagless page batches",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-352-fatal-fifo-"));
    const entry = path.join(temp, "a.html");
    const port = await freePort();
    const stateDir = path.join(temp, "state");
    const env = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-fatal-fifo-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const cli = path.join(repoRoot, "dist", "cli.mjs");
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    const state = async () => JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    try {
      for (const page of ["a", "b"])
        await writeFile(
          path.join(temp, page + ".html"),
          `<!doctype html><body><button onclick="const image=document.createElement('img'); image.src='missing-${page}.png'; document.body.append(image)">Fail ${page.toUpperCase()}</button><a href="b.html">Go B</a></body>`,
        );
      const opened = run(process.execPath, [cli, entry, "--no-open"], env);
      const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, opened);
      const key = new URL(url).pathname.split("/").at(-1);
      browser("open", url);
      await eventually(
        async () => browser("eval", "() => currentArtifactBinding?.page"),
        (text) => text.includes("a.html"),
        "A did not bind",
      );
      browser(
        "eval",
        `() => {
        annotation = false; postToFrame({type:'lavish:setAnnotationMode', enabled:false});
        window.__fatalReports = []; const original = window.fetch;
        window.fetch = function(url, init) {
          if (String(url).endsWith('/artifact-failures')) window.__fatalReports.push(JSON.parse(init.body));
          return original.apply(this, arguments);
        }; return true;
      }`,
      );
      // A ref goes stale when the chrome DOM mutates between the snapshot and the click
      // (the layout gate settling, presence updates), so re-snapshot and retry like 352-B01.
      const click = (label) => {
        let staleError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const line = browser("snapshot")
            .split("\n")
            .find((line) => line.includes(label));
          assert.ok(line, label);
          try {
            browser("click", "@" + line.trim().split(/\s+/)[0].replace(/^uid=/, ""));
            return;
          } catch (error) {
            if (!/STALE_REF|Stale ref/.test(String(error?.message || error))) throw error;
            staleError = error;
          }
        }
        throw staleError;
      };
      click("Fail A");
      await eventually(
        state,
        (value) => value.sessions[key].artifact_failures.some((failure) => failure.page === "a.html"),
        "A failure did not reach store",
      );
      click("Go B");
      await eventually(
        async () => browser("eval", "() => currentArtifactBinding?.page"),
        (text) => text.includes("b.html"),
        "B did not bind",
      );
      click("Fail B");
      const queued = await eventually(
        state,
        (value) => value.sessions[key].artifact_failures.some((failure) => failure.page === "b.html"),
        "B failure did not reach store",
      );
      assert.deepEqual(
        queued.sessions[key].feedback_batches.map((batch) => [batch.page, batch.modern]),
        [
          ["a.html", true],
          ["b.html", true],
        ],
      );
      assert.match(
        browser(
          "eval",
          "() => window.__fatalReports.length === 2 && window.__fatalReports.every(r => !('page_protocol' in r) && r.page && r.page_proof && r.document_sequence > 0)",
        ),
        /result:\s*"true"/,
      );
      const first = run(process.execPath, [cli, "poll", entry, "--timeout-ms", "1000"], env);
      const second = run(process.execPath, [cli, "poll", entry, "--timeout-ms", "1000"], env);
      assert.match(first, /missing-a\.png/);
      assert.doesNotMatch(first, /missing-b\.png/);
      assert.match(second, /missing-b\.png/);
      assert.doesNotMatch(second, /missing-a\.png/);
      assert.equal((await state()).sessions[key].artifact_failures.length, 0);
    } finally {
      cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], env);
      cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "352 exact POSIX entry remains reviewable and foreign framing gains no review authority",
  { skip: !runBrowserE2e || path.sep !== "/", timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-352-exact-entry-"));
    const entry = path.join(temp, "report\\final.html");
    const stateDir = path.join(temp, "state");
    const port = await freePort();
    const env = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-exact-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const cli = path.join(repoRoot, "dist", "cli.mjs");
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    const readState = async () => JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    let hostileServer = null;
    try {
      await writeFile(entry, '<!doctype html><body style="font:16px system-ui"><p>Exact entry target</p></body>');
      const opened = run(process.execPath, [cli, entry, "--no-open"], env);
      const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, opened);
      const key = new URL(url).pathname.split("/").pop();
      browser("open", url);
      // A ref goes stale when the chrome DOM mutates between the snapshot and the click
      // (the layout gate settling, presence updates), so re-snapshot and retry like 352-B01.
      const click = (label) => {
        let staleError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const line = browser("snapshot")
            .split("\n")
            .find((line) => line.includes(label));
          assert.ok(line, label);
          try {
            browser("click", "@" + line.trim().split(/\s+/)[0].replace(/^uid=/, ""));
            return;
          } catch (error) {
            if (!/STALE_REF|Stale ref/.test(String(error?.message || error))) throw error;
            staleError = error;
          }
        }
        throw staleError;
      };
      await eventually(
        async () => browser("snapshot"),
        (tree) => tree.includes("Exact entry target") && !tree.includes("Checking layout."),
        "exact entry did not bind",
      );
      click("Exact entry target");
      browser("type", "Literal entry draft");
      const revision = (await readState()).sessions[key].artifact_revision;
      browser("eval", '() => { document.getElementById("reloadArtifact").click(); return true; }');
      await eventually(readState, (state) => state.sessions[key].artifact_revision > revision, "reload did not start");
      await eventually(
        async () => browser("snapshot"),
        (tree) => tree.includes("Literal entry draft") && !tree.includes("Checking layout."),
        "entry draft did not survive reload",
      );
      click('button "Queue"');
      browser("eval", '() => { document.getElementById("send").click(); return true; }');
      const state = await eventually(
        readState,
        (state) => state.sessions[key].prompts.length > 0,
        "annotation was not delivered",
      );
      assert.equal(state.sessions[key].prompts[0].page, path.basename(entry));
      assert.equal(state.sessions[key].snapshot_page, path.basename(entry));

      const artifactUrl = new URL(`/artifact/${key}/${encodeURIComponent(path.basename(entry))}`, url).href;
      const before = (await readState()).sessions[key];
      // The hostile parent speaks the CURRENT protocol: it answers readiness with a real
      // MessageChannel challenge (no auth, forged auth, the public nonce as auth, and the genuine
      // MAC the chrome would hand to an external page left in its artifact frame), tries to
      // activate the port anyway, replays the obsolete bind, and drives review routes directly.
      const hostile = `<script>
        window.received=[];window.portMessages=[];window.routeStatuses=[];window.oracle=[];
        const asked={};
        addEventListener('message',e=>{
          received.push(e.data);
          if(e.data&&e.data.relay!==undefined)return;
          const auths=[undefined,'forged-mac',e.data&&e.data.document_nonce];
          for(const chrome_auth of auths){
            const c=new MessageChannel();
            c.port1.onmessage=m=>portMessages.push(m.data);
            e.source.postMessage({type:'lavish:challenge',challenge:'hostile',chrome_auth},'*',[c.port2]);
            c.port1.postMessage({type:'lavish:activate',document_id:e.data&&e.data.document_id,document_sequence:1});
          }
          const nonce=e.data&&e.data.document_nonce;
          if(nonce&&!asked[nonce]){
            asked[nonce]=true;
            const source=e.source;
            fetch('/mac?nonce='+encodeURIComponent(nonce)).then(r=>r.json()).then(b=>{
              oracle.push(b.chrome_auth||'');
              if(!b.chrome_auth)return;
              const c=new MessageChannel();
              c.port1.onmessage=m=>portMessages.push(m.data);
              source.postMessage({type:'lavish:challenge',challenge:'relayed',chrome_auth:b.chrome_auth},'*',[c.port2]);
            },()=>oracle.push(''));
          }
          e.source.postMessage({type:'lavish:bind',...e.data},'*');
          e.source.postMessage({type:'lavish:setAnnotationMode',enabled:true},'*');
        });
        const post=(path,body)=>fetch('${new URL("/", url).href}api/${key}/'+path,{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify(body)}).then(r=>routeStatuses.push(path+':'+r.status),()=>routeStatuses.push(path+':blocked'));
        post('prompts',{prompts:[{prompt:'hostile prompt'}]});
        post('artifact-failures',{failures:[{kind:'artifact-unavailable'}]});
        post('layout-diagnostics',{findings:[],complete:true});
        post('attachments',{});
        post('whiteboard-channel',{});
        post('artifact-bindings/chrome-auth',{document_nonce:'x'.repeat(32)});
      </script><iframe id="direct" src="${artifactUrl}"></iframe>
      <iframe id="intermediate" sandbox="allow-scripts" srcdoc="<script>parent.postMessage({relay:'alive'},'*');addEventListener('message',e=>parent.postMessage({relay:e.data},'*'))</script><iframe src='${artifactUrl}'></iframe>"></iframe>`;
      const live = new URL(
        (await fetch(artifactUrl).then((response) => response.text())).match(
          /<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/,
        )?.[1] || "",
        artifactUrl,
      );
      const hostilePort = await freePort();
      hostileServer = spawn(process.execPath, ["-e", HOSTILE_SERVER_SCRIPT], {
        env: {
          ...process.env,
          LAVISH_HOSTILE_PORT: String(hostilePort),
          LAVISH_HOSTILE_HTML: Buffer.from(hostile).toString("base64"),
          LAVISH_HOSTILE_ORACLE: JSON.stringify({
            url: new URL(`/api/${key}/artifact-bindings/chrome-auth`, url).href,
            origin: new URL(url).origin,
            artifact_load_token: live.searchParams.get("artifact_load_token"),
            artifact_revision: Number(live.searchParams.get("artifact_revision")),
          }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await Promise.race([
        once(hostileServer.stdout, "data").then(([chunk]) => assert.match(String(chunk), /READY/)),
        once(hostileServer, "error").then(([error]) => Promise.reject(error)),
        once(hostileServer, "exit").then(([code]) => Promise.reject(new Error(`hostile server exited ${code}`))),
      ]);
      browser("open", `http://127.0.0.1:${hostilePort}/`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const result = browser(
        "eval",
        "() => JSON.stringify({received: window.received, ports: window.portMessages, routes: window.routeStatuses.sort(), oracle: window.oracle})",
      );
      const observed = parseEvalJson(result);
      assert.ok(observed.oracle.length > 0, "the hostile parent asked the oracle for the document's MAC");
      for (const auth of observed.oracle) assert.ok(auth, "the relayed MAC is the genuine one");
      // The authored page renders and may announce readiness, but that is all a foreign parent gets.
      assert.match(browser("snapshot"), /Exact entry target/);
      assert.deepEqual(observed.ports, [], "no challenge response or bound-port traffic reaches a foreign parent");
      const direct = observed.received.filter((message) => message?.type);
      assert.ok(direct.length > 0, "the directly framed document only announces readiness");
      for (const message of direct) {
        assert.deepEqual(Object.keys(message).sort(), ["document_id", "document_nonce", "page_protocol", "type"]);
        assert.equal(message.type, "lavish:ready");
      }
      // The intermediate sandboxed frame proves it was alive and relayed nothing from the artifact:
      // a document whose parent is not the top window never even announces readiness.
      const relayed = observed.received.filter((message) => message?.relay !== undefined);
      assert.deepEqual(relayed, [{ relay: "alive" }]);
      const leaked = JSON.stringify(observed);
      assert.doesNotMatch(leaked, /page_proof|artifact_load_token|challengeResponse/);
      assert.equal(observed.routes.length, 6);
      for (const status of observed.routes) assert.match(status, /:(blocked|4\d\d)$/, status);
      const after = (await readState()).sessions[key];
      assert.deepEqual(after.prompts, before.prompts);
      assert.deepEqual(after.artifact_failures || [], before.artifact_failures || []);
      assert.deepEqual(after.layout_warnings || [], before.layout_warnings || []);
      assert.equal(after.artifact_revision, before.artifact_revision);
      assert.equal(after.status, before.status);
    } finally {
      if (hostileServer?.exitCode === null) {
        hostileServer.kill();
        await once(hostileServer, "exit");
      }
      cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], env);
      cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "352 authored nested sibling iframes render as authored without review controls, under one working top bar",
  { skip: !runBrowserE2e, timeout: 240_000 },
  async () => {
    const temp = await realpath(await mkdtemp(path.join(tmpdir(), "lavish-352-nested-")));
    const entry = path.join(temp, "entry.html");
    const stateDir = path.join(temp, "state");
    const port = await freePort();
    const env = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-nested-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const cli = path.join(repoRoot, "dist", "cli.mjs");
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    const readState = async () => JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    const childScript = (name) => `<script>
      const say = (text) => { const p = document.createElement('p'); p.textContent = text; document.body.append(p); };
      let lavish = 0;
      addEventListener('message', (e) => { if (String(e.data && e.data.type).startsWith('lavish:')) lavish += 1; });
      say('${name} script ran');
      const img = new Image();
      img.onload = () => say('${name} asset loaded ' + img.naturalWidth);
      img.onerror = () => say('${name} asset FAILED');
      img.src = 'pixel.png';
      setTimeout(() => say('${name} css ' + getComputedStyle(document.body).outlineStyle + ' lavish messages ' + lavish + ' lavish ui ' + document.querySelectorAll('[data-lavish-ui]').length), 1500);
    </script>`;
    try {
      await mkdir(path.join(temp, "sub"));
      await writeFile(
        path.join(temp, "sub", "pixel.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      await writeFile(path.join(temp, "sub", "child.css"), "body { outline: 1px dashed red; }");
      for (const name of ["static", "dynamic"]) {
        await writeFile(
          path.join(temp, "sub", `${name}.html`),
          `<!doctype html><link rel="stylesheet" href="child.css"><body><p>${name} child paragraph</p><a href="deeper.html">${name} go deeper</a>${childScript(name)}</body>`,
        );
      }
      await writeFile(
        path.join(temp, "sub", "deeper.html"),
        `<!doctype html><link rel="stylesheet" href="child.css"><body><p>deeper paragraph</p>${childScript("deeper")}</body>`,
      );
      await writeFile(
        entry,
        `<!doctype html><body style="font:16px system-ui">
          <script type="application/json" data-lavish-revisions>[{"id":"r2","label":"Second pass","timestamp":"2026-09-20T10:00:00Z","summary":"Reworded the block"}]</script>
          <p>Outer review paragraph</p><p data-lavish-revision="r2">Revised outer block</p>
          <iframe src="sub/static.html" style="width:420px;height:160px"></iframe>
          <script>setTimeout(() => { const f = document.createElement('iframe'); f.src = 'sub/dynamic.html'; f.style.cssText = 'width:420px;height:160px'; document.body.append(f); }, 300);</script>
        </body>`,
      );
      const opened = run(process.execPath, [cli, entry, "--no-open"], env);
      const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, opened);
      const key = new URL(url).pathname.split("/").pop();
      browser("open", url);
      // A ref goes stale when the chrome DOM mutates between the snapshot and the click
      // (the layout gate settling, presence updates), so re-snapshot and retry like 352-B01.
      const click = (label) => {
        let staleError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const line = browser("snapshot")
            .split("\n")
            .find((line) => line.includes(label));
          assert.ok(line, label);
          try {
            browser("click", "@" + line.trim().split(/\s+/)[0].replace(/^uid=/, ""));
            return;
          } catch (error) {
            if (!/STALE_REF|Stale ref/.test(String(error?.message || error))) throw error;
            staleError = error;
          }
        }
        throw staleError;
      };
      // Static and dynamically created nested siblings render, run authored script, apply their
      // relative stylesheet, load a relative image, and never see or host the Lavish SDK.
      const rendered = await eventually(
        async () => browser("snapshot"),
        (tree) =>
          ["static", "dynamic"].every(
            (name) =>
              tree.includes(`${name} script ran`) &&
              tree.includes(`${name} asset loaded 1`) &&
              tree.includes(`${name} css dashed lavish messages 0 lavish ui 0`),
          ) && !tree.includes("Checking layout."),
        "nested sibling iframes did not render as authored",
        30_000,
      );
      assert.doesNotMatch(rendered, /asset FAILED/);

      // r54: exactly one bar, no duplicate ids anywhere in the rendered chrome.
      const dom = parseEvalJson(
        browser(
          "eval",
          "() => { const ids=[...document.querySelectorAll('[id]')].map(e=>e.id); return JSON.stringify({bars:document.querySelectorAll('.bar').length, duplicates:ids.filter((id,i)=>ids.indexOf(id)!==i), revisionsHidden:document.getElementById('revisionsWrap').hidden, revisionsCount:document.getElementById('revisionsCount').textContent}); }",
        ),
      );
      assert.deepEqual(dom, { bars: 1, duplicates: [], revisionsHidden: false, revisionsCount: "1" });

      // Annotation mode is on, yet a click inside a nested sibling is a plain authored click:
      // native nested navigation happens and no annotation card appears for it.
      click("static go deeper");
      const deeper = await eventually(
        async () => browser("snapshot"),
        (tree) => tree.includes("deeper css dashed lavish messages 0 lavish ui 0"),
        "nested navigation did not render the deeper sibling",
        30_000,
      );
      assert.match(deeper, /deeper asset loaded 1/);
      assert.doesNotMatch(deeper, /button "Queue"/);
      click("dynamic child paragraph");
      assert.doesNotMatch(browser("snapshot"), /button "Queue"/);

      // #361 revisions drawer and reveal work from the single wired bar.
      browser("eval", "() => { document.getElementById('revisionsButton').click(); return true; }");
      const drawer = await eventually(
        async () => browser("snapshot"),
        (tree) => tree.includes("Second pass"),
        "revisions drawer did not open",
      );
      assert.match(drawer, /Reveal the next block changed in Second pass/);
      assert.match(
        browser(
          "eval",
          "() => { const b=document.querySelector('#revisionsList .revision-reveal'); b.click(); return document.getElementById('revisionsButton').getAttribute('aria-expanded') + ':' + document.querySelectorAll('#revisionsList .revision-reveal').length; }",
        ),
        /:1/,
      );
      browser("eval", "() => { document.getElementById('revisionsButton').click(); return true; }");

      // Annotation switch is wired: explore mode stops outer clicks from opening a card.
      const pressed = () => browser("eval", "() => document.getElementById('annotation').getAttribute('aria-pressed')");
      assert.match(pressed(), /true/);
      browser("eval", "() => { document.getElementById('annotation').click(); return true; }");
      assert.match(pressed(), /false/);
      click("Outer review paragraph");
      assert.doesNotMatch(browser("snapshot"), /button "Queue"/);
      browser("eval", "() => { document.getElementById('annotation').click(); return true; }");
      assert.match(pressed(), /true/);

      // Overflow menu opens; Reload artifact advances the revision and nested frames re-render.
      browser("eval", "() => { document.getElementById('moreButton').click(); return true; }");
      assert.match(
        browser(
          "eval",
          "() => String(document.getElementById('moreMenu').hidden) + ':' + document.getElementById('moreButton').getAttribute('aria-expanded')",
        ),
        /false:true/,
      );
      const revision = (await readState()).sessions[key].artifact_revision;
      browser("eval", "() => { document.getElementById('reloadArtifact').click(); return true; }");
      await eventually(readState, (state) => state.sessions[key].artifact_revision > revision, "reload did not start");
      await eventually(
        async () => browser("snapshot"),
        (tree) =>
          tree.includes("dynamic css dashed lavish messages 0 lavish ui 0") && tree.includes("static script ran"),
        "nested siblings did not re-render after reload",
        30_000,
      );

      // Outer review still delivers feedback attributed to the entry page only.
      click("Outer review paragraph");
      browser("type", "Outer note beside nested frames");
      click('button "Queue"');
      browser("eval", "() => { document.getElementById('send').click(); return true; }");
      const delivered = await eventually(
        readState,
        (state) => state.sessions[key].prompts.length > 0,
        "outer annotation was not delivered",
      );
      assert.equal(delivered.sessions[key].prompts.length, 1);
      assert.equal(delivered.sessions[key].prompts[0].page, "entry.html");
      assert.deepEqual(delivered.sessions[key].artifact_failures || [], []);

      // Layout-warning control stays wired (hidden with no warnings, single instance).
      assert.match(
        browser(
          "eval",
          "() => String(document.getElementById('warningsWrap').hidden) + ':' + document.querySelectorAll('#warningsButton').length",
        ),
        /true:1/,
      );

      // Terminal control: End session from the one bar ends the stored session.
      browser(
        "eval",
        "() => { document.getElementById('moreButton').click(); document.getElementById('end').click(); return true; }",
      );
      const confirm = browser("snapshot");
      if (/End session/.test(confirm) && /button "End/.test(confirm)) {
        const line = confirm.split("\n").find((line) => /button "End/.test(line) && !/More/.test(line));
        if (line) browser("click", "@" + line.trim().split(/\s+/)[0].replace(/^uid=/, ""));
      }
      const endedState = await eventually(
        readState,
        (state) => state.sessions[key].status === "ended",
        "End session did not end the session",
      );
      assert.equal(endedState.sessions[key].ended_by, "user");
    } finally {
      cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], env);
      cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

// '/mac' stands in for the chrome, which fetches the MAC for whatever nonce its frame announces.
const HOSTILE_SERVER_SCRIPT = String.raw`
const http = require("node:http");
const html = Buffer.from(process.env.LAVISH_HOSTILE_HTML, "base64");
const oracle = process.env.LAVISH_HOSTILE_ORACLE ? JSON.parse(process.env.LAVISH_HOSTILE_ORACLE) : null;
const server = http.createServer(async (req, res) => {
  const requested = new URL(req.url, "http://127.0.0.1");
  if (requested.pathname === "/mac" && oracle) {
    const body = await fetch(oracle.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: oracle.origin },
      body: JSON.stringify({
        artifact_load_token: oracle.artifact_load_token,
        artifact_revision: oracle.artifact_revision,
        document_nonce: requested.searchParams.get("nonce"),
      }),
    })
      .then((response) => response.json())
      .catch(() => ({}));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
server.listen(Number(process.env.LAVISH_HOSTILE_PORT), "127.0.0.1", () => process.stdout.write("READY\\n"));
`;

// `eval` prints a TOON string holding the page's own JSON string; unwrap until it is a value.
function parseEvalJson(output) {
  let value = output.match(/result:\s*(".*")\s*$/m)?.[1];
  assert.ok(value, output);
  while (typeof value === "string") value = JSON.parse(value);
  return value;
}

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function cleanupRun(command, args, env, timeout = 15_000) {
  spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

async function eventually(read, predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`${message}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

test("352-B01", { skip: !runBrowserE2e, timeout: 240_000 }, async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "lavish-352-b01-"));
  const entry = path.join(temp, "start.html");
  const siblingDir = path.join(temp, "sub");
  const sibling = path.join(siblingDir, "index.html");
  const stylesheet = path.join(temp, "review.css");
  const stateDir = path.join(temp, "state");
  const stateFile = path.join(stateDir, "state.json");
  await mkdir(siblingDir);
  await writeFile(stylesheet, "body { font: 16px system-ui; }\n");
  await writeFile(
    entry,
    '<!doctype html><html><head><link rel="stylesheet" href="review.css"></head><body><main><p id="entry-target">Entry review target</p><a href="sub/index.html">Open sibling review page</a></main></body></html>',
  );
  await writeFile(
    sibling,
    '<!doctype html><html><head><link rel="stylesheet" href="../review.css"></head><body><main><p id="sibling-target">Sibling review target</p></main></body></html>',
  );
  const originalBytes = new Map([
    [entry, await readFile(entry)],
    [sibling, await readFile(sibling)],
    [stylesheet, await readFile(stylesheet)],
  ]);
  const canonicalEntry = await realpath(entry);
  const port = await freePort();
  const lavishEnv = {
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
  };
  const chromeEnv = {
    CHROME_DEVTOOLS_AXI_SESSION: `lavish-352-b01-${process.pid}`,
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
  };
  const cli = path.join(repoRoot, "dist", "cli.mjs");

  function snapshot() {
    return run("chrome-devtools-axi", ["snapshot"], chromeEnv);
  }

  function ref(pattern) {
    const tree = snapshot();
    const line = tree.split("\n").find((candidate) => pattern.test(candidate));
    assert.ok(line, `no snapshot line matching ${pattern}:\n${tree}`);
    return line.trim().split(/\s+/)[0].replace(/^uid=/, "");
  }

  function click(pattern) {
    let staleError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        run("chrome-devtools-axi", ["click", `@${ref(pattern)}`], chromeEnv);
        return;
      } catch (error) {
        if (!/STALE_REF/.test(String(error?.message || error))) throw error;
        staleError = error;
      }
    }
    throw staleError;
  }

  async function state() {
    return JSON.parse(await readFile(stateFile, "utf8"));
  }

  let observations;
  try {
    const opened = run(process.execPath, [cli, entry, "--no-open"], lavishEnv);
    const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, opened);
    const sessionKey = new URL(url).pathname.split("/").pop();
    assert.ok(sessionKey);

    run("chrome-devtools-axi", ["open", url], chromeEnv);
    run("chrome-devtools-axi", ["emulate", "--viewport", "1440x1000x1"], chromeEnv);
    const entryView = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Entry review target") && !tree.includes("Checking layout."),
      "entry document never became reviewable",
    );
    const initialState = await state();
    const initialRevision = initialState.sessions[sessionKey].artifact_revision;

    click(/Entry review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "entry annotation card did not open",
    );
    run("chrome-devtools-axi", ["type", "Entry annotation note"], chromeEnv);
    click(/button "Queue"/);
    const entryQueued = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Entry annotation note"),
      "entry annotation was not queued",
    );

    click(/button "Annotate"/);
    click(/Open sibling review page/);
    const siblingView = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Sibling review target") && !tree.includes("Checking layout."),
      "authored sibling did not become reviewable",
    );
    click(/button "Annotate"/);
    click(/Sibling review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "sibling annotation card did not open",
    );
    run("chrome-devtools-axi", ["type", "Sibling question note"], chromeEnv);
    click(/button "Queue"/);
    const siblingQueued = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Sibling question note"),
      "sibling question was not queued",
    );

    click(/button "More"/);
    click(/button "Reload artifact"/);
    await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Sibling review target") && !tree.includes("Checking layout."),
      "reloaded sibling did not become reviewable",
    );

    run("chrome-devtools-axi", ["back"], chromeEnv);
    const backView = await eventually(
      async () => snapshot(),
      (tree) => /RootWebArea url="[^"]*\/artifact\/[^/]+\/start\.html(?:[?#][^"]*)?"/.test(tree),
      "browser Back did not restore the entry document",
    );
    click(/Entry review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "BFCache-restored entry did not regain review controls",
    );
    run("chrome-devtools-axi", ["eval", "() => { history.forward(); return true; }"], chromeEnv);
    const forwardView = await eventually(
      async () => snapshot(),
      (tree) => /RootWebArea url="[^"]*\/artifact\/[^/]+\/sub\/index\.html(?:[?#][^"]*)?"/.test(tree),
      "browser Forward did not restore the sibling document",
    );
    click(/Sibling review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "Forward-restored sibling did not regain review controls",
    );

    click(/button "Send to Agent"/);
    const queuedState = await eventually(
      state,
      (value) => value.sessions?.[sessionKey]?.pending_prompts === 1,
      "the active-page batch did not reach the real store",
    );
    const storedSession = queuedState.sessions[sessionKey];
    const pollOutput = run(process.execPath, [cli, "poll", entry, "--timeout-ms", "10000"], lavishEnv, 30_000);
    const consumedState = await state();
    const consumedSession = consumedState.sessions[sessionKey];
    const finalBytes = new Map(
      await Promise.all(
        [...originalBytes.keys()].map(
          /** @returns {Promise<[string, Buffer]>} */ async (file) => [file, await readFile(file)],
        ),
      ),
    );

    observations = {
      opened,
      url,
      sessionKey,
      entryView,
      entryQueued,
      siblingView,
      siblingQueued,
      backView,
      forwardView,
      initialRevision,
      storedSession,
      pollOutput,
      consumedSession,
      sessionKeys: Object.keys(queuedState.sessions),
      originalBytes,
      finalBytes,
      canonicalEntry,
    };

    await t.test("cli-entry", (child) => {
      child.plan(3);
      child.assert.match(observations.opened, /status: opened/);
      child.assert.match(observations.url, new RegExp(`/session/${observations.sessionKey}$`));
      child.assert.match(observations.entryView, /Entry review target/);
    });
    await t.test("entry-annotation", (child) => {
      child.plan(1);
      child.assert.match(observations.entryQueued, /Entry annotation note/);
    });
    await t.test("authored-sibling-question", (child) => {
      child.plan(3);
      child.assert.match(observations.siblingView, /Sibling review target/);
      child.assert.match(observations.siblingQueued, /Sibling question note/);
      child.assert.equal(observations.storedSession.prompts[0].prompt, "Sibling question note");
    });
    await t.test("back-forward", (child) => {
      child.plan(2);
      child.assert.match(observations.backView, /Entry review target/);
      child.assert.match(observations.forwardView, /Sibling review target/);
    });
    await t.test("sole-session", (child) => {
      child.plan(2);
      child.assert.deepEqual(observations.sessionKeys, [observations.sessionKey]);
      child.assert.equal(observations.storedSession.file, observations.canonicalEntry);
    });
    await t.test("prompt-pages", (child) => {
      child.plan(3);
      child.assert.deepEqual(
        observations.storedSession.prompts.map((prompt) => prompt.page),
        ["sub/index.html"],
      );
      child.assert.doesNotMatch(observations.pollOutput, /,start\.html/);
      child.assert.match(observations.pollOutput, /,sub\/index\.html/);
    });
    await t.test("single-sibling-snapshot", (child) => {
      child.plan(4);
      child.assert.equal(observations.storedSession.snapshot_page, "sub/index.html");
      child.assert.match(observations.storedSession.dom_snapshot, /Sibling review target/);
      child.assert.doesNotMatch(observations.storedSession.dom_snapshot, /Entry review target/);
      child.assert.match(observations.pollOutput, /snapshot_page: sub\/index\.html[\s\S]*dom_snapshot:/);
    });
    await t.test("pending-consumed", (child) => {
      child.plan(3);
      child.assert.match(observations.pollOutput, /status: feedback/);
      child.assert.equal(observations.consumedSession.pending_prompts, 0);
      child.assert.deepEqual(observations.consumedSession.prompts, []);
    });
    await t.test("source-bytes", (child) => {
      child.plan(3);
      for (const [file, original] of observations.originalBytes) {
        child.assert.deepEqual(observations.finalBytes.get(file), original);
      }
    });
    await t.test("reload-generation", (child) => {
      child.plan(2);
      child.assert.equal(observations.storedSession.artifact_revision > observations.initialRevision, true);
      child.assert.equal(observations.consumedSession.artifact_revision, observations.storedSession.artifact_revision);
    });
  } finally {
    cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], lavishEnv);
    cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
    await rm(temp, { recursive: true, force: true });
  }
});
