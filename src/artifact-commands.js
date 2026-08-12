import path from "node:path";

import { AxiError } from "axi-sdk-js";

import { composeArtifact } from "./artifact-composer.js";
import {
  addRegistryComponent,
  createComponent,
  createRecipe,
  inspectComponent,
  inspectRecipe,
  listComponents,
  listRecipes,
  registerComponent,
  removeComponent,
  removeRecipe,
  searchComponents,
  setRecipeTokens,
  updateRecipeComponents,
  updateRecipeRequiredComponents,
  updateRecipeSlots,
} from "./artifact-registry.js";

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function firstPositionalArg(args, valueFlags = []) {
  const consumesValue = new Set(valueFlags);
  for (let index = 0; index < args.length; index += 1) {
    if (consumesValue.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("-")) return args[index];
  }
  return undefined;
}

function artifactCommandError(error, help) {
  if (error instanceof AxiError) return error;
  return new AxiError(error instanceof Error ? error.message : String(error), "VALIDATION_ERROR", help);
}

export async function registryCommand(args) {
  const action = args[0] || "list";
  try {
    if (action === "list") {
      return {
        components: await listComponents(),
        next_step: "Run `lavish-axi registry search <need>` or `lavish-axi registry inspect <component>`",
      };
    }
    if (action === "search") {
      const query = args
        .slice(1)
        .filter((arg) => !arg.startsWith("-"))
        .join(" ");
      if (!query) throw new Error("Registry search requires a query");
      return {
        components: await searchComponents(query),
        next_step: "Run `lavish-axi registry inspect <component>` for the best match",
      };
    }
    if (action === "inspect") {
      const name = args[1];
      if (!name) throw new Error("Registry inspect requires a component name");
      return { component: await inspectComponent(name, { includeSource: args.includes("--source") }) };
    }
    if (action === "create") {
      const name = args[1];
      if (!name) throw new Error("Registry create requires a component name");
      return createComponent(name, {
        summary: flagValue(args, "--summary") || "",
        useWhen: flagValue(args, "--use-when") || "",
      });
    }
    if (action === "register") {
      const source = args[1];
      if (!source) throw new Error("Registry register requires a component directory");
      return registerComponent(path.resolve(source));
    }
    if (action === "remove") {
      const name = args[1];
      if (!name) throw new Error("Registry remove requires a component name");
      return removeComponent(name);
    }
    if (action === "add") {
      const address = args[1];
      if (!address) throw new Error("Registry add requires a shadcn registry item address");
      return addRegistryComponent(address, { dryRun: args.includes("--dry-run") });
    }
    throw new Error(`Unknown registry action: ${action}`);
  } catch (error) {
    throw artifactCommandError(error, ["Run `lavish-axi registry --help` for registry commands"]);
  }
}

export async function recipeCommand(args) {
  const action = args[0] || "list";
  try {
    if (action === "list") {
      return { recipes: await listRecipes(), next_step: "Run `lavish-axi recipe inspect <recipe>`" };
    }
    if (action === "inspect") {
      const name = args[1];
      if (!name) throw new Error("Recipe inspect requires a recipe name");
      return { recipe: await inspectRecipe(name, { includeSource: args.includes("--source") }) };
    }
    if (action === "create") {
      const name = args[1];
      if (!name) throw new Error("Recipe create requires a recipe name");
      return createRecipe(name, { summary: flagValue(args, "--summary") || "" });
    }
    if (action === "add-component" || action === "remove-component") {
      const name = args[1];
      const component = args[2];
      if (!name || !component) throw new Error(`Recipe ${action} requires a recipe and component name`);
      return updateRecipeComponents(name, component, action === "add-component" ? "add" : "remove");
    }
    if (action === "require-component" || action === "unrequire-component") {
      const name = args[1];
      const component = args[2];
      if (!name || !component) throw new Error(`Recipe ${action} requires a recipe and component name`);
      return updateRecipeRequiredComponents(name, component, action === "require-component" ? "add" : "remove");
    }
    if (action === "add-slot" || action === "remove-slot") {
      const name = args[1];
      const slot = args[2];
      if (!name || !slot) throw new Error(`Recipe ${action} requires a recipe and slot name`);
      return updateRecipeSlots(name, slot, action === "add-slot" ? "add" : "remove");
    }
    if (action === "set-tokens") {
      const name = args[1];
      const stylesheet = args[2];
      if (!name || !stylesheet) throw new Error("Recipe set-tokens requires a recipe and stylesheet path");
      return setRecipeTokens(name, path.resolve(stylesheet));
    }
    if (action === "remove") {
      const name = args[1];
      if (!name) throw new Error("Recipe remove requires a recipe name");
      return removeRecipe(name);
    }
    throw new Error(`Unknown recipe action: ${action}`);
  } catch (error) {
    throw artifactCommandError(error, ["Run `lavish-axi recipe --help` for recipe commands"]);
  }
}

export async function composeCommand(args) {
  const recipe = firstPositionalArg(args, ["--input", "--out"]);
  const input = flagValue(args, "--input");
  const output = flagValue(args, "--out");
  if (!recipe || !input || !output) {
    throw new AxiError("Compose requires a recipe, --input, and --out", "VALIDATION_ERROR", [
      "Run `lavish-axi compose <recipe> --input <file.toon> --out <file.html>`",
    ]);
  }
  try {
    return await composeArtifact(recipe, path.resolve(input), path.resolve(output));
  } catch (error) {
    throw artifactCommandError(error, [
      `Run \`lavish-axi recipe inspect ${recipe}\``,
      "Run `lavish-axi registry search <need>` to find reusable components",
    ]);
  }
}
