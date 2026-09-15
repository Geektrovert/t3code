/**
 * PukuCliModelCatalog — model catalog for the Puku CLI driver.
 *
 * puku-cli (`@puku/puku-cli`) is a near-clone of Claude Code. It preserves
 * Anthropic-style model ids and aliases (`sonnet`, `opus`, `haiku`,
 * `claude-sonnet-5`, etc.) and routes them to the same Anthropic backend by
 * default. The catalog below mirrors the Claude catalog's `model` shapes
 * (slug, name, capabilities) so the UI picker works without custom wiring,
 * and exposes the puku-friendly aliases so users can pass `--model sonnet`
 * directly when launching the CLI.
 *
 * When the bundled puku catalog diverges from Anthropic's, swap
 * `BUNDLED_PUKU_CLI_MODEL_CATALOG` for a remote-loaded manifest entry the
 * same way `ClaudeModelCatalog` does.
 *
 * @module provider/PukuCliModelCatalog
 */
import type {
  CustomModelSetting,
  ModelCapabilities,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { readCustomModelEntries } from "@t3tools/shared/model";

/**
 * The catalog of models puku-cli accepts out of the box. Aliases are puku's
 * user-facing shortcuts (`sonnet`, `opus`, `haiku`); the slug is the full
 * model id t3code stores and surfaces in the picker.
 */
interface PukuCliCatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly isDefault?: boolean;
  readonly capabilities?: ModelCapabilities;
}

const DEFAULT_PUKU_CLI_CATALOG: ReadonlyArray<PukuCliCatalogEntry> = [
  {
    slug: "sonnet",
    name: "Sonnet",
    aliases: ["sonnet-latest", "claude-sonnet"],
    isDefault: true,
  },
  {
    slug: "opus",
    name: "Opus",
    aliases: ["opus-latest", "claude-opus"],
  },
  {
    slug: "haiku",
    name: "Haiku",
    aliases: ["haiku-latest", "claude-haiku"],
  },
];

export interface PukuCliModelCatalog {
  readonly models: ReadonlyArray<{
    readonly model: ServerProviderModel;
  }>;
}

function toServerProviderModel(entry: PukuCliCatalogEntry): ServerProviderModel {
  return {
    slug: entry.slug,
    name: entry.name,
    ...(entry.aliases ? { aliases: [...entry.aliases] } : {}),
    isCustom: false,
    ...(entry.isDefault ? { isDefault: true } : {}),
    capabilities: entry.capabilities ?? createModelCapabilities({ optionDescriptors: [] }),
  };
}

export const BUNDLED_PUKU_CLI_MODEL_CATALOG: PukuCliModelCatalog = {
  models: DEFAULT_PUKU_CLI_CATALOG.map((entry) => ({
    model: toServerProviderModel(entry),
  })),
};

/**
 * Resolve a slug or alias to a known catalog slug. Falls back to the input
 * unchanged (puku-cli may accept a model id we don't know about) so a
 * `--model <custom-id>` round-trip still works.
 */
export function resolvePukuCliModelSlug(
  catalog: PukuCliModelCatalog,
  slugOrAlias: string,
): string {
  const value = slugOrAlias.trim();
  if (!value) return slugOrAlias;
  const direct = catalog.models.find((entry) => entry.model.slug === value);
  if (direct) return direct.model.slug;
  const aliasMatch = catalog.models.find((entry) =>
    entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
  );
  return aliasMatch?.model.slug ?? value;
}

/**
 * Scope the catalog to one instance's settings: custom model slugs stay
 * opaque (a built-in alias they shadow is dropped, canonical slugs and
 * capabilities are preserved), and custom entries that declare their own
 * capabilities are appended so the adapter resolves effort/fast mode
 * against the user's descriptors instead of the empty default.
 */
export function scopePukuCliModelCatalog(
  catalog: PukuCliModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): PukuCliModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const customAliases = new Set(customEntries.map((entry) => entry.slug.toLowerCase()));

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
      },
    };
  });
  const builtInSlugs = new Set(builtInModels.map((entry) => entry.model.slug));
  const customCatalogModels: Array<{ readonly model: ServerProviderModel }> = [];
  for (const entry of customEntries) {
    if (!entry.capabilities || builtInSlugs.has(entry.slug)) continue;
    customCatalogModels.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: entry.capabilities,
      },
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
}
