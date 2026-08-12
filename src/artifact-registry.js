import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { decode, encode } from "@toon-format/toon";
import Mustache from "mustache";

const CATALOG_VERSION = 1;
const MAX_DEPENDENCY_DEPTH = 20;
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BUILTIN_ROOT = path.join(import.meta.dirname, "artifact-builtins");

function validateName(name, kind) {
  if (!NAME_PATTERN.test(String(name || ""))) {
    throw new Error(`${kind} name must use lowercase letters, numbers, and single hyphens`);
  }
  return name;
}

function slash(file) {
  return file.split(path.sep).join("/");
}

function relativePath(root, file) {
  return slash(path.relative(root, file));
}

async function canonicalExisting(file) {
  return realpath(path.resolve(file));
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function confinedExisting(root, file, label) {
  const canonicalRoot = await canonicalExisting(root);
  const canonicalFile = await canonicalExisting(file);
  if (!isInside(canonicalRoot, canonicalFile)) {
    throw new Error(`${label} must stay inside the project`);
  }
  return canonicalFile;
}

export async function resolveArtifactProjectRoot(start = process.cwd()) {
  let current = await canonicalExisting(start);
  const boundary = path.parse(current).root;
  while (current !== boundary) {
    if (existsSync(path.join(current, ".git"))) return current;
    current = path.dirname(current);
  }
  return await canonicalExisting(start);
}

function projectPaths(projectRoot) {
  const lavishRoot = path.join(projectRoot, "lavish");
  return {
    lavishRoot,
    catalog: path.join(lavishRoot, "registry.json"),
    components: path.join(lavishRoot, "components"),
    recipes: path.join(lavishRoot, "recipes"),
    shadcn: path.join(lavishRoot, "shadcn", "registry.json"),
  };
}

async function readToon(file) {
  try {
    const value = decode(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top-level value must be an object");
    }
    return /** @type {Record<string, any>} */ (value);
  } catch (error) {
    throw new Error(`Cannot decode ${file}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function emptyCatalog() {
  return { version: CATALOG_VERSION, components: {}, recipes: {} };
}

async function builtInCatalog() {
  return readJson(path.join(BUILTIN_ROOT, "registry.json"), emptyCatalog());
}

async function projectCatalog(projectRoot) {
  const catalog = await readJson(projectPaths(projectRoot).catalog, emptyCatalog());
  if (catalog.version !== CATALOG_VERSION) {
    throw new Error(`Unsupported Lavish registry version: ${catalog.version}`);
  }
  return catalog;
}

async function resolvedCatalog(projectRoot) {
  const [builtIn, project] = await Promise.all([builtInCatalog(), projectCatalog(projectRoot)]);
  return {
    version: CATALOG_VERSION,
    components: { ...builtIn.components, ...project.components },
    recipes: { ...builtIn.recipes, ...project.recipes },
  };
}

function sourceRoot(record, projectRoot) {
  return record.origin === "builtin" ? path.join(BUILTIN_ROOT, record.source) : path.join(projectRoot, record.source);
}

function componentSummary(record) {
  return {
    name: record.name,
    summary: record.summary,
    use_when: record.use_when,
    origin: record.origin,
  };
}

export async function listComponents({ projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const catalog = await resolvedCatalog(root);
  return Object.values(catalog.components)
    .map(componentSummary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function searchComponents(query, { projectRoot = process.cwd() } = {}) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const components = await listComponents({ projectRoot });
  return components
    .map((component) => {
      const haystack = `${component.name} ${component.summary} ${component.use_when}`.toLowerCase();
      return { component, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
    })
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || a.component.name.localeCompare(b.component.name))
    .map(({ component }) => component);
}

export async function inspectComponent(name, { projectRoot = process.cwd(), includeSource = false } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const catalog = await resolvedCatalog(root);
  const record = catalog.components[name];
  if (!record) throw new Error(`Unknown component: ${name}`);
  const source = sourceRoot(record, root);
  return {
    ...componentSummary(record),
    required_inputs: record.inputs || [],
    partials: record.partials || [],
    assets: [record.style, record.behavior].filter(Boolean),
    example: relativePath(root, path.join(source, record.example || "example.toon")),
    ...(includeSource ? { source: relativePath(root, source) } : {}),
    next_step: includeSource
      ? `Edit the source, then run \`lavish-axi registry register ${relativePath(root, source)}\``
      : `Run \`lavish-axi registry inspect ${name} --source\` to locate its source, or invoke it through \`lavish-axi compose\``,
  };
}

function templateFacts(template, { allowSlots = false } = {}) {
  let parsed;
  try {
    parsed = Mustache.parse(template);
  } catch (error) {
    throw new Error(`Invalid Mustache template: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const inputs = new Set();
  const partials = new Set();
  const visit = (tokens, nested = false) => {
    for (const token of tokens) {
      const [type, rawName] = token;
      const name = String(rawName || "").trim();
      if (type === ">") partials.add(name);
      if ((type === "&" || type === "{") && !(allowSlots && name.startsWith("lavish_"))) {
        throw new Error(`Unescaped Mustache input: ${name}`);
      }
      if (!nested && ["name", "#", "^"].includes(type) && name !== "." && !name.startsWith("lavish_")) {
        inputs.add(name.split(".")[0]);
      }
      if ((type === "#" || type === "^") && Array.isArray(token[4])) visit(token[4], true);
    }
  };
  visit(parsed);
  return { inputs: [...inputs].sort(), partials: [...partials].sort() };
}

async function componentRecord(source, projectRoot) {
  const metadata = await readToon(path.join(source, "component.toon"));
  const name = validateName(metadata.name || path.basename(source), "Component");
  const templateFile = path.join(source, "template.mustache");
  const exampleFile = path.join(source, "example.toon");
  const template = await readFile(templateFile, "utf8");
  const facts = templateFacts(template);
  const example = await readToon(exampleFile);

  const optionalFile = async (filename) => {
    const file = path.join(source, filename);
    try {
      const details = await stat(file);
      if (!details.isFile()) throw new Error(`${filename} must be a file`);
      await confinedExisting(projectRoot, file, filename);
      return filename;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  };

  return {
    record: {
      name,
      summary: String(metadata.summary || "").trim(),
      use_when: String(metadata.use_when || "").trim(),
      origin: "project",
      source: relativePath(projectRoot, source),
      template: "template.mustache",
      example: "example.toon",
      own_inputs: facts.inputs,
      inputs: facts.inputs,
      partials: facts.partials,
      style: await optionalFile("style.css"),
      behavior: await optionalFile("behavior.js"),
    },
    example,
  };
}

function assertComponentGraph(components) {
  const visiting = new Set();
  const visited = new Set();
  const visit = (name, depth) => {
    if (depth > MAX_DEPENDENCY_DEPTH) throw new Error(`Component dependency depth exceeds ${MAX_DEPENDENCY_DEPTH}`);
    if (visiting.has(name)) throw new Error(`Component dependency cycle includes ${name}`);
    if (visited.has(name)) return;
    const component = components[name];
    if (!component) throw new Error(`Unknown component partial: ${name}`);
    visiting.add(name);
    for (const partial of component.partials || []) visit(partial, depth + 1);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(components)) visit(name, 0);
}

function resolveComponentInputs(components) {
  const resolved = {};
  const visit = (name) => {
    if (resolved[name]) return resolved[name];
    const component = components[name];
    const inputs = new Set(component.own_inputs || component.inputs || []);
    for (const partial of component.partials || []) {
      for (const input of visit(partial).inputs || []) inputs.add(input);
    }
    resolved[name] = { ...component, inputs: [...inputs].sort() };
    return resolved[name];
  };
  for (const name of Object.keys(components)) visit(name);
  return resolved;
}

function assertExampleContract(record, example) {
  const missing = record.inputs.filter((input) => !Object.hasOwn(example, input));
  if (missing.length) throw new Error(`Component example is missing inputs: ${missing.join(", ")}`);
  const extra = Object.keys(example).filter((input) => !record.inputs.includes(input));
  if (extra.length) throw new Error(`Component example has unknown inputs: ${extra.join(", ")}`);
}

async function writeToon(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${encode(value)}\n`);
}

async function writeProjectCatalog(projectRoot, catalog) {
  const paths = projectPaths(projectRoot);
  await mkdir(path.dirname(paths.catalog), { recursive: true });
  await writeFile(paths.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
  await writeShadcnCatalog(projectRoot, catalog);
  return [relativePath(projectRoot, paths.catalog), relativePath(projectRoot, paths.shadcn)];
}

async function allSourceFiles(projectRoot, record) {
  const source = sourceRoot(record, projectRoot);
  const entries = await readdir(source, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relativePath(projectRoot, path.join(source, entry.name)))
    .sort();
}

async function writeShadcnCatalog(projectRoot, catalog) {
  const items = [];
  for (const record of [...Object.values(catalog.components), ...Object.values(catalog.recipes)]) {
    if (record.origin !== "project") continue;
    const files = await allSourceFiles(projectRoot, record);
    items.push({
      name: record.name,
      type: record.kind === "recipe" ? "registry:block" : "registry:component",
      title: record.name,
      description: record.summary,
      files: files.map((file) => ({ path: file, type: "registry:file", target: `~/${file}` })),
    });
  }
  const output = {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: "lavish-project",
    homepage: "https://github.com/kunchenguid/lavish-axi",
    items: items.sort((a, b) => a.name.localeCompare(b.name)),
  };
  const file = projectPaths(projectRoot).shadcn;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(output, null, 2)}\n`);
}

export async function createComponent(name, { projectRoot = process.cwd(), summary = "", useWhen = "" } = {}) {
  validateName(name, "Component");
  const root = await resolveArtifactProjectRoot(projectRoot);
  const source = path.join(projectPaths(root).components, name);
  if (existsSync(source)) throw new Error(`Component source already exists: ${relativePath(root, source)}`);
  await mkdir(source, { recursive: true });
  const files = {
    "component.toon": encode({ name, summary: String(summary), use_when: String(useWhen) }) + "\n",
    "template.mustache": '<section class="lavish-component">{{content}}</section>\n',
    "example.toon": "content: Replace this example\n",
  };
  for (const [filename, content] of Object.entries(files)) await writeFile(path.join(source, filename), content);
  return {
    component: name,
    changed_paths: Object.keys(files).map((filename) => relativePath(root, path.join(source, filename))),
    next_step: `Edit the component files, then run \`lavish-axi registry register ${relativePath(root, source)}\``,
  };
}

export async function registerComponent(componentDirectory, { projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const source = await confinedExisting(root, componentDirectory, "Component source");
  const project = await projectCatalog(root);
  const builtIn = await builtInCatalog();
  const { record, example } = await componentRecord(source, root);
  const components = { ...builtIn.components, ...project.components, [record.name]: record };
  assertComponentGraph(components);
  const resolved = resolveComponentInputs(components);
  const projectComponents = { ...project.components, [record.name]: record };
  for (const name of Object.keys(projectComponents)) {
    const componentExample =
      name === record.name
        ? example
        : await readToon(path.join(sourceRoot(resolved[name], root), resolved[name].example || "example.toon"));
    assertExampleContract(resolved[name], componentExample);
  }
  project.components = Object.fromEntries(Object.keys(projectComponents).map((name) => [name, resolved[name]]));
  const catalogPaths = await writeProjectCatalog(root, project);
  return {
    component: componentSummary(resolved[record.name]),
    required_inputs: resolved[record.name].inputs,
    changed_paths: [...catalogPaths],
    next_step: `Run \`lavish-axi registry inspect ${record.name}\` or invoke it through \`lavish-axi compose\``,
  };
}

export async function removeComponent(name, { projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const project = await projectCatalog(root);
  const record = project.components[name];
  if (!record) throw new Error(`Unknown project component: ${name}`);
  const dependents = Object.values({ ...project.components, ...project.recipes }).filter((item) =>
    [...(item.partials || []), ...(item.components || []), ...(item.required_components || [])].includes(name),
  );
  if (dependents.length)
    throw new Error(`Component ${name} is used by: ${dependents.map((item) => item.name).join(", ")}`);
  await rm(sourceRoot(record, root), { recursive: true });
  delete project.components[name];
  const changed = await writeProjectCatalog(root, project);
  return { removed: name, removed_paths: [record.source], changed_paths: changed };
}

export async function listRecipes({ projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const catalog = await resolvedCatalog(root);
  return Object.values(catalog.recipes)
    .map((recipe) => ({ name: recipe.name, summary: recipe.summary, origin: recipe.origin }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function inspectRecipe(name, { projectRoot = process.cwd(), includeSource = false } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const catalog = await resolvedCatalog(root);
  const record = catalog.recipes[name];
  if (!record) throw new Error(`Unknown recipe: ${name}`);
  const source = sourceRoot(record, root);
  return {
    name: record.name,
    summary: record.summary,
    origin: record.origin,
    slots: record.slots || [],
    components: record.components || [],
    required_components: record.required_components || [],
    tokens: record.tokens || null,
    ...(includeSource ? { source: relativePath(root, source) } : {}),
    next_step: `Write a TOON composition, then run \`lavish-axi compose ${name} --input <file.toon> --out <file.html>\``,
  };
}

async function persistRecipe(projectRoot, project, record) {
  project.recipes[record.name] = record;
  const source = sourceRoot(record, projectRoot);
  await writeToon(path.join(source, "recipe.toon"), {
    name: record.name,
    summary: record.summary,
    slots: record.slots,
    components: record.components,
    required_components: record.required_components,
    ...(record.tokens ? { tokens: record.tokens } : {}),
  });
  return writeProjectCatalog(projectRoot, project);
}

export async function createRecipe(name, { projectRoot = process.cwd(), summary = "" } = {}) {
  validateName(name, "Recipe");
  const root = await resolveArtifactProjectRoot(projectRoot);
  const project = await projectCatalog(root);
  const source = path.join(projectPaths(root).recipes, name);
  if (existsSync(source) || project.recipes[name]) throw new Error(`Recipe already exists: ${name}`);
  await mkdir(source, { recursive: true });
  await writeFile(
    path.join(source, "shell.mustache"),
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{title}}</title>{{#lavish_stylesheet}}<link rel="stylesheet" href="{{{lavish_stylesheet}}}">{{/lavish_stylesheet}}</head><body>{{{lavish_slot_body}}}{{#lavish_script}}<script src="{{{lavish_script}}}" defer></script>{{/lavish_script}}</body></html>\n',
  );
  await writeFile(path.join(source, "tokens.css"), ":root {\n  color-scheme: light dark;\n}\n");
  const record = {
    kind: "recipe",
    name,
    summary: String(summary),
    origin: "project",
    source: relativePath(root, source),
    shell: "shell.mustache",
    slots: ["body"],
    components: [],
    required_components: [],
    tokens: "tokens.css",
  };
  const changed = await persistRecipe(root, project, record);
  return {
    recipe: name,
    changed_paths: [
      relativePath(root, path.join(source, "shell.mustache")),
      relativePath(root, path.join(source, "tokens.css")),
      relativePath(root, path.join(source, "recipe.toon")),
      ...changed,
    ],
    next_step: `Run \`lavish-axi recipe add-component ${name} <component>\``,
  };
}

export async function updateRecipeComponents(name, component, action, { projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const project = await projectCatalog(root);
  const resolved = await resolvedCatalog(root);
  const record = project.recipes[name];
  if (!record) throw new Error(`Unknown project recipe: ${name}`);
  if (!resolved.components[component]) throw new Error(`Unknown component: ${component}`);
  const components = new Set(record.components || []);
  if (action === "add") components.add(component);
  else if (action === "remove") {
    if ((record.required_components || []).includes(component)) {
      throw new Error(`Component ${component} is required by recipe ${name}; unrequire it before removing it`);
    }
    components.delete(component);
  }
  else throw new Error(`Unknown recipe component action: ${action}`);
  record.components = [...components].sort();
  const changed = await persistRecipe(root, project, record);
  return { recipe: name, components: record.components, changed_paths: changed };
}

export async function updateRecipeRequiredComponents(name, component, action, { projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const project = await projectCatalog(root);
  const resolved = await resolvedCatalog(root);
  const record = project.recipes[name];
  if (!record) throw new Error(`Unknown project recipe: ${name}`);
  if (!resolved.components[component]) throw new Error(`Unknown component: ${component}`);
  const required = new Set(record.required_components || []);
  if (action === "add") {
    required.add(component);
    record.components = [...new Set([...(record.components || []), component])].sort();
  } else if (action === "remove") {
    required.delete(component);
  } else {
    throw new Error(`Unknown required component action: ${action}`);
  }
  record.required_components = [...required].sort();
  const changed = await persistRecipe(root, project, record);
  return {
    recipe: name,
    components: record.components,
    required_components: record.required_components,
    changed_paths: changed,
  };
}

export async function updateRecipeSlots(name, slot, action, { projectRoot = process.cwd() } = {}) {
  validateName(slot, "Slot");
  const root = await resolveArtifactProjectRoot(projectRoot);
  const project = await projectCatalog(root);
  const record = project.recipes[name];
  if (!record) throw new Error(`Unknown project recipe: ${name}`);
  const slots = new Set(record.slots || []);
  if (action === "add") slots.add(slot);
  else if (action === "remove") {
    if (slots.size === 1 && slots.has(slot)) throw new Error("A recipe must keep at least one slot");
    slots.delete(slot);
  } else throw new Error(`Unknown recipe slot action: ${action}`);
  record.slots = [...slots].sort();
  const changed = await persistRecipe(root, project, record);
  return { recipe: name, slots: record.slots, changed_paths: changed };
}

export async function setRecipeTokens(name, stylesheet, { projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const project = await projectCatalog(root);
  const record = project.recipes[name];
  if (!record) throw new Error(`Unknown project recipe: ${name}`);
  const file = await confinedExisting(root, stylesheet, "Token stylesheet");
  record.tokens = relativePath(sourceRoot(record, root), file);
  const changed = await persistRecipe(root, project, record);
  return { recipe: name, tokens: record.tokens, changed_paths: changed };
}

export async function removeRecipe(name, { projectRoot = process.cwd() } = {}) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const project = await projectCatalog(root);
  const record = project.recipes[name];
  if (!record) throw new Error(`Unknown project recipe: ${name}`);
  await rm(sourceRoot(record, root), { recursive: true });
  delete project.recipes[name];
  const changed = await writeProjectCatalog(root, project);
  return { removed: name, removed_paths: [record.source], changed_paths: changed };
}

export async function addRegistryComponent(
  address,
  { projectRoot = process.cwd(), dryRun = false, getItems = null } = {},
) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  const fetchItems = getItems || (await import("shadcn/registry")).getRegistryItems;
  const items = await fetchItems([address]);
  if (items.length !== 1) throw new Error(`Registry address must resolve to one item: ${address}`);
  const item = items[0];
  validateName(item.name, "Component");
  const required = new Map();
  for (const file of item.files || []) {
    if (typeof file.content !== "string") continue;
    const filename = path.basename(file.target || file.path);
    if (
      ["component.toon", "template.mustache", "example.toon", "style.css", "behavior.js", "README.md"].includes(
        filename,
      )
    ) {
      required.set(filename, file.content);
    }
  }
  for (const filename of ["component.toon", "template.mustache", "example.toon"]) {
    if (!required.has(filename)) throw new Error(`Registry item does not contain ${filename}`);
  }
  const destination = path.join(projectPaths(root).components, item.name);
  const planned = [...required.keys()].sort().map((filename) => relativePath(root, path.join(destination, filename)));
  if (dryRun) return { address, component: item.name, planned_paths: planned, installed: false };
  if (existsSync(destination)) throw new Error(`Component source already exists: ${relativePath(root, destination)}`);
  try {
    await mkdir(destination, { recursive: true });
    for (const [filename, content] of required) await writeFile(path.join(destination, filename), content);
    const registered = await registerComponent(destination, { projectRoot: root });
    return { address, component: item.name, planned_paths: planned, installed: true, ...registered };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

export async function registryContext(projectRoot = process.cwd()) {
  const root = await resolveArtifactProjectRoot(projectRoot);
  return { root, catalog: await resolvedCatalog(root), sourceRoot };
}

export { templateFacts };
