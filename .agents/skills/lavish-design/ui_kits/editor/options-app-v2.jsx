/* global React, ReactDOM, DesignCanvas, DCSection, DCArtboard, ChromePaired, ChromeSplit, ChromeFinish */

const noteStyle2 = { fontFamily: "var(--font-sans)", fontSize: 13, lineHeight: 1.5, color: "var(--steel-100)" };
const tagStyle2 = { display: "inline-block", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--brass-500)", marginBottom: 6, letterSpacing: "0.04em" };

function Cap({ tag, children }) {
  return (
    <div style={{ width: 840, marginTop: 10 }}>
      <div style={tagStyle2}>{tag}</div>
      <div style={noteStyle2} dangerouslySetInnerHTML={{ __html: children }} />
    </div>
  );
}

function OptionsV2() {
  return (
    <DesignCanvas>
      <DCSection
        id="bar"
        title="The bar, emptied"
        subtitle="Wordmark · Annotate switch · ⋯. The file path, reload and snapshot all move inside the ⋯ menu — shown open on the third board."
      >
        <DCArtboard id="paired" label="D · Paired footer actions" width={840} height={560}>
          <ChromePaired />
          <Cap tag="D · PAIRED FOOTER — clearest hierarchy">
            Bar drops to three things. Both session actions move to the composer footer, where your attention already is: <b>End session</b> sits left as a quiet rust text-button, <b>Send to Agent</b> filled on the right. Reads like a form — secondary action left, primary right. Nothing destructive in the chrome's top edge anymore.
          </Cap>
        </DCArtboard>

        <DCArtboard id="split" label="E · Split send button" width={840} height={560}>
          <ChromeSplit />
          <Cap tag="E · SPLIT SEND — one footprint, two intents">
            A single primary control. <b>Send to Agent</b> with a <b>▾</b> that opens <b>Send &amp; end session</b> — your “send” muscle memory works, and ending is one deliberate notch away in the same spot. Tightest footer; the trade is that ending is slightly hidden.
          </Cap>
        </DCArtboard>

        <DCArtboard id="finish" label="F · Send is the finish (⋯ open)" width={840} height={560}>
          <ChromeFinish />
          <Cap tag="F · SEND IS THE FINISH — boldest reframe">
            Treats ending as a <i>kind</i> of send. Full-width <b>Send to Agent</b>, and a whisper-quiet text link beneath: <b>Send a final note &amp; end session</b>. The ⋯ menu is shown open here so you can see where the file path lands — under an <b>“Editing”</b> label, with Reload and Copy DOM snapshot below.
          </Cap>
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<OptionsV2 />);
