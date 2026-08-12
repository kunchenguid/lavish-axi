import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { decode } from "@toon-format/toon";
import Mustache from "mustache";

import { registryContext, templateFacts } from "./artifact-registry.js";

const MAX_COMPONENTS = 500;
const MAX_DATA_BYTES = 2 * 1024 * 1024;

function slash(file) {
  return file.split(path.sep).join("/");
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * @param {string} file
 * @param {string} projectRoot
 * @param {(file: string, bytes: number) => void} [onRead]
 */
async function readStructured(file, projectRoot, onRead = () => {}) {
  const resolved = await realpath(path.resolve(file));
  if (!isInside(projectRoot, resolved)) throw new Error(`Composition data must stay inside the project: ${file}`);
  const source = await readFile(resolved, "utf8");
  if (Buffer.byteLength(source) > MAX_DATA_BYTES)
    throw new Error(`Composition data exceeds ${MAX_DATA_BYTES} bytes: ${file}`);
  onRead(resolved, Buffer.byteLength(source));
  if (path.extname(resolved).toLowerCase() === ".json") return JSON.parse(source);
  return decode(source);
}

async function resolveConfinedWrite(file, projectRoot, { directory = false } = {}) {
  const requested = path.resolve(file);
  let ancestor = path.dirname(requested);
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      const resolved = path.resolve(canonicalAncestor, path.relative(ancestor, requested));
      if (!isInside(projectRoot, resolved)) throw new Error("Composition output must stay inside the project");
      if (directory) {
        await mkdir(resolved, { recursive: true });
        const output = await realpath(resolved);
        if (!isInside(projectRoot, output)) throw new Error("Composition output must stay inside the project");
        return output;
      }
      await mkdir(path.dirname(resolved), { recursive: true });
      const parent = await realpath(path.dirname(resolved));
      let output = path.join(parent, path.basename(resolved));
      try {
        output = await realpath(output);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        try {
          await lstat(output);
          throw new Error("Composition output must stay inside the project", { cause: error });
        } catch (leafError) {
          if (leafError?.code !== "ENOENT") throw leafError;
        }
      }
      if (!isInside(projectRoot, output)) throw new Error("Composition output must stay inside the project");
      return output;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

async function readSourceFile(record, source, filename, context) {
  const requested = path.resolve(source, filename);
  const resolved = await realpath(requested);
  const boundary = record.origin === "project" ? context.root : source;
  const canonicalBoundary = await realpath(boundary);
  if (!isInside(canonicalBoundary, resolved)) {
    throw new Error(`Artifact source must stay inside its ${record.origin} root: ${filename}`);
  }
  return readFile(resolved, "utf8");
}

function validateInputs(component, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Component ${component.name} data must be an object`);
  }
  const required = component.inputs || [];
  const missing = required.filter((input) => !Object.hasOwn(data, input));
  if (missing.length)
    throw new Error(
      `Component ${component.name} is missing inputs: ${missing.join(", ")}. Run \`lavish-axi registry inspect ${component.name}\``,
    );
  const extra = Object.keys(data).filter((input) => !required.includes(input));
  if (extra.length)
    throw new Error(
      `Component ${component.name} has unknown inputs: ${extra.join(", ")}. Run \`lavish-axi registry inspect ${component.name}\``,
    );
}

async function componentSources(name, context, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const record = context.catalog.components[name];
  if (!record) throw new Error(`Unknown component: ${name}. Run \`lavish-axi registry search ${name}\``);
  const source = context.sourceRoot(record, context.root);
  const dependencies = [];
  for (const partial of record.partials || []) dependencies.push(...(await componentSources(partial, context, seen)));
  return [...dependencies, { record, source }];
}

async function renderComponent(name, data, context) {
  const sources = await componentSources(name, context);
  const current = sources.at(-1);
  validateInputs(current.record, data);
  /** @type {Record<string, string>} */
  const partials = {};
  for (const item of sources.slice(0, -1)) {
    partials[item.record.name] = await readSourceFile(item.record, item.source, item.record.template, context);
  }
  const template = await readSourceFile(current.record, current.source, current.record.template, context);
  return { html: Mustache.render(template, data, partials), sources };
}

export async function composeArtifact(recipeName, inputFile, outputFile, { projectRoot = process.cwd() } = {}) {
  const context = await registryContext(projectRoot);
  const recipe = context.catalog.recipes[recipeName];
  if (!recipe) throw new Error(`Unknown recipe: ${recipeName}. Run \`lavish-axi recipe list\``);
  const recipeSource = context.sourceRoot(recipe, context.root);
  const sourceSizes = new Map();
  const recordSourceSize = (file, bytes) => sourceSizes.set(file, bytes);
  const input = await readStructured(inputFile, context.root, recordSourceSize);
  if (!Array.isArray(input.components)) throw new Error("Composition must contain a components array");
  if (input.components.length > MAX_COMPONENTS)
    throw new Error(`Composition exceeds ${MAX_COMPONENTS} component calls`);

  const slots = Object.fromEntries((recipe.slots || []).map((slot) => [slot, []]));
  const used = new Map();
  for (const call of input.components) {
    const componentName = String(call.component || "");
    const slot = String(call.slot || "");
    if (!Object.hasOwn(slots, slot))
      throw new Error(`Unknown recipe slot: ${slot}. Run \`lavish-axi recipe inspect ${recipeName}\``);
    if ((recipe.components || []).length && !recipe.components.includes(componentName)) {
      throw new Error(
        `Component ${componentName} is not allowed by recipe ${recipeName}. Run \`lavish-axi recipe inspect ${recipeName}\``,
      );
    }
    let data = call.inputs;
    if (typeof call.data === "string")
      data = await readStructured(path.resolve(path.dirname(inputFile), call.data), context.root, recordSourceSize);
    if (data === undefined) data = {};
    const rendered = await renderComponent(componentName, data, context);
    slots[slot].push(rendered.html);
    for (const item of rendered.sources) used.set(item.record.name, item);
  }

  const missing = (recipe.required_components || []).filter((name) => !used.has(name));
  if (missing.length) throw new Error(`Recipe ${recipeName} requires components: ${missing.join(", ")}`);
  if (!recipe.tokens) throw new Error(`Recipe ${recipeName} must configure a project token stylesheet`);

  const css = [await readSourceFile(recipe, recipeSource, recipe.tokens, context)];
  const scripts = [];
  for (const { record, source } of used.values()) {
    if (record.style) css.push(await readSourceFile(record, source, record.style, context));
    if (record.behavior) scripts.push(await readSourceFile(record, source, record.behavior, context));
  }

  const output = await resolveConfinedWrite(outputFile, context.root);
  const parsed = path.parse(output);
  const assetsName = `${parsed.name}.assets`;
  const assetsDir = await resolveConfinedWrite(path.join(parsed.dir, assetsName), context.root, { directory: true });
  const stylesheet = css.length ? `${assetsName}/styles.css` : "";
  const script = scripts.length ? `${assetsName}/components.js` : "";
  if (css.length)
    await writeFile(
      await resolveConfinedWrite(path.join(assetsDir, "styles.css"), context.root),
      `${css.join("\n")}\n`,
    );
  if (scripts.length)
    await writeFile(
      await resolveConfinedWrite(path.join(assetsDir, "components.js"), context.root),
      `${scripts.join("\n")}\n`,
    );

  const shell = await readSourceFile(recipe, recipeSource, recipe.shell, context);
  templateFacts(shell, { allowSlots: true });
  const view = {
    title: String(input.title || recipeName),
    lavish_recipe: recipeName,
    lavish_components: [...used.keys()].sort().join(","),
    lavish_stylesheet: stylesheet,
    lavish_script: script,
  };
  for (const [slot, fragments] of Object.entries(slots)) view[`lavish_slot_${slot}`] = fragments.join("\n");
  const html = Mustache.render(shell, view);
  await writeFile(output, html);
  const inputBytes = [...sourceSizes.values()].reduce((total, bytes) => total + bytes, 0);
  const artifactBytes =
    Buffer.byteLength(html) + Buffer.byteLength(css.join("\n")) + Buffer.byteLength(scripts.join("\n"));
  const savedBytes = Math.max(0, artifactBytes - inputBytes);

  return {
    artifact: slash(path.relative(context.root, output)),
    recipe: recipeName,
    components: [...used.values()].map(({ record }) => ({ name: record.name, origin: record.origin })),
    assets: [stylesheet, script].filter(Boolean),
    input_bytes: inputBytes,
    artifact_bytes: artifactBytes,
    markup_bytes_avoided: savedBytes,
    input_reduction_percent: artifactBytes ? Number(((savedBytes / artifactBytes) * 100).toFixed(1)) : 0,
    next_step: `Run \`lavish-axi ${slash(path.relative(context.root, output))}\` to review the composed artifact`,
  };
}
