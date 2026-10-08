/**
 * Programmatic entry point.
 *
 * The CLI is the primary interface, but the pieces are exported so the harness
 * can be embedded in other tooling (custom scripts, CI checks, editor plugins).
 */
export { detectNextJsVersion, detectFromPackageJson, detectFromLock } from './cli/nextjs/detect-version.js';
export {
  buildVersion,
  docsLineForMajor,
  majorForDocsLine,
  parseConstraint,
  parseExact,
  versionFromString,
  SUPPORTED_MAJORS,
  type NextJsVersion,
} from './cli/nextjs/version.js';
export { findProjectRoot, harnessPaths, requireNextJsProject, type NextJsProject } from './cli/nextjs/project.js';

export { ensureConfig, loadConfig, requireConfig, saveConfig, updateConfig } from './generators/config-generator/config.js';
export {
  configSchema,
  defaultConfig,
  CURRENT_CONFIG_VERSION,
  DEFAULT_EMBEDDING_MODEL,
  type HarnessConfig,
  type SpecIncludeEntry,
} from './generators/config-generator/schema.js';

export {
  type EmbeddingProvider,
  cosineSimilarity,
  deserializeVector,
  serializeVector,
} from './rags/embeddings/provider.js';
export { reciprocalRankFusion, rankByScore } from './rags/embeddings/rrf.js';
export {
  embeddingsNotReadyError,
  fuseHybrid,
  hybridPoolSize,
  type HybridCorpus,
  type HybridDocument,
} from './rags/embeddings/hybrid.js';
export {
  createEmbeddingWriter,
  embeddingText,
  EMBED_BATCH_SIZE,
  type EmbeddableChunk,
  type EmbeddingWriter,
  type VectorStore,
} from './rags/embeddings/indexing.js';
export { createTransformersEmbeddingProvider } from './rags/embeddings/transformers-provider.js';

export { openCorpus, type ResolvedCorpus } from './rags/manuals/corpus.js';
export {
  downloadDocs,
  fetchDocsTree,
  fetchHeadCommit,
  readManualMeta,
  safeDocPath,
  syncManuals,
  type ManualMeta,
  type SyncResult,
} from './rags/manuals/downloader.js';
export { indexManuals, listMarkdownFiles, type IndexResult } from './rags/manuals/indexer.js';
export { hashContent, parsePage, sectionForPath, urlForPath, type ParsedChunk } from './rags/manuals/parser.js';
export { ManualRepository, type SearchHit, type StoredDocument } from './rags/manuals/repository.js';
export {
  buildMatchExpression,
  buildPrefixExpression,
  searchManuals,
  tokenizeQuery,
  type LexicalStrategy,
  type SearchOutcome,
} from './rags/manuals/search.js';

export { createServer, startMcpServer, SERVER_NAME } from './mcp/server.js';
export { createMcpContext, type McpContext } from './mcp/context.js';

export {
  inspectRegistration,
  registerServer,
  type RegistrationState,
} from './generators/ai-code-mcp.js';
export { MCP_ARGS, MCP_COMMAND, PACKAGE_NAME, mcpCommandLine } from './generators/mcp-entry.js';

export {
  ALL_TARGETS,
  TARGETS,
  detectTargets,
  isTargetId,
  parseTargetIds,
  requireTarget,
} from './generators/targets/registry.js';
export {
  TARGET_IDS,
  type FileOutcome,
  type TargetDefinition,
  type TargetId,
  type TargetPartResult,
} from './generators/targets/types.js';
export {
  installTarget,
  installTargets,
  installInstructionsFor,
  installRolesFor,
  registerTargets,
  targetManifestFile,
  type TargetInstallResult,
} from './generators/targets/install.js';
export {
  installInstructions,
  instructionsBody,
  instructionsInstalled,
  SHARED_REFERENCES_DIR,
  SHARED_ROLES_DIR,
} from './generators/targets/instructions.js';
export { installRoles, opencodeTools } from './generators/targets/roles.js';
export {
  inspectRegistrations,
  inspectTargetRegistration,
  registerTargetServer,
  type TargetRegistrationState,
} from './generators/targets/mcp.js';
export {
  findBlock,
  installManagedBlock,
  removeManagedBlock,
  wrapBlock,
  BLOCK_END,
  BLOCK_START,
} from './generators/targets/managed-block.js';

export {
  discoverSpecFiles,
  globToRegExp,
  includePattern,
  includeTags,
  normalizeTags,
  type SpecInclude,
} from './rags/specs/discovery.js';
export { indexSpecs, type SpecIndexResult } from './rags/specs/indexer.js';
export { parseSpec, sectionForSpecPath, type SpecChunk } from './rags/specs/parser.js';
export { SpecRepository, type SpecHit, type StoredSpec } from './rags/specs/repository.js';
export {
  openSpecCorpus,
  searchSpecs,
  specIndexFile,
  type OpenSpecCorpusOptions,
  type ResolvedSpecCorpus,
  type SpecCorpusStrategy,
  type SearchSpecsOptions,
  type SpecSearchOutcome,
} from './rags/specs/search.js';

export { installSkill, skillDirFor, type SkillInstallResult } from './generators/skill/installer.js';
export { agentsDirFor, installAgents, AGENT_NAMES } from './generators/agent/installer.js';
export {
  installTemplateSet,
  packageTemplateDir,
  render,
  type TemplateInstallResult,
} from './generators/template-installer.js';

export { runDoctor, type DoctorCheck, type DoctorReport } from './cli/commands/doctor.js';

export { HarnessError, isHarnessError } from './errors.js';
