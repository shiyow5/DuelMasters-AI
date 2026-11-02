export {
  parseDecklist,
  detectZoneHeading,
  type ParsedDeck,
  type DeckZone,
  type ExtraZones,
} from "./parser.js";
export { validateRegulation, checkExtraZones } from "./validator.js";
export { scoreDeck } from "./scorer.js";
export {
  inferDeckConcept,
  inferDeckArchetype,
  isRelaxedConcept,
  conceptLabel,
  archetypeLabel,
  type DeckConcept,
  type DeckArchetype,
} from "./concept.js";
export {
  autoBuild,
  suggestReplacements,
  type BuildConstraints,
  type BuildResult,
} from "./builder.js";
export { inferTagsByRule } from "./tagger.js";
export { computeTribalSynergy, type TribalSynergy } from "./synergy.js";
export {
  classifyRegulations,
  applyRegulationToRequired,
  type RegulationSets,
} from "./regulation-rules.js";
export {
  buildRegulationIndex,
  lookupRegulation,
  type RegulationIndex,
  type RegulationRow,
} from "./regulation-index.js";
export {
  loadRegulations,
  checkRegulationNames,
  listRestrictedInDeck,
  regulationTagForCard,
  restrictionLimitLabel,
  UNRESTRICTED,
  type RegulationsLoad,
  type RegulationCheck,
  type RestrictedInDeck,
} from "./regulation-check.js";
