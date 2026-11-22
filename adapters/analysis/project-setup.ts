import { z } from 'zod';
import {
  ProjectAnalysisCatalog,
  type ProjectAnalyzer,
  type AuthorizedMaterialText,
} from '../../core/project-analysis.ts';
import { ResearchResultSchema } from '../../protocol/operations.ts';

export const PROJECT_SETUP_ANALYSIS_REVISION = 'project-setup-v1';
/** Prompt excerpts are explicit context projection, not permission or an execution allowance. */
export const SETUP_MATERIAL_EXCERPT_CHARACTERS = 4000;
export const SETUP_TOTAL_MATERIAL_EXCERPT_CHARACTERS = 16000;
function materialContext(materials: readonly AuthorizedMaterialText[]) {
  let remaining = SETUP_TOTAL_MATERIAL_EXCERPT_CHARACTERS;
  return materials.map((material) => {
    const metadata = {
      id: material.id,
      name: material.name,
      mimeType: material.mimeType,
      hash: material.hash,
      textHash: material.textHash,
      representation: material.representation,
      note: material.note,
    };
    if (material.representation !== 'text' || material.text === undefined)
      return {
        ...metadata,
        note:
          material.note || 'Reference only; no text or visual interpretation has been provided.',
      };
    const text = material.text.slice(0, Math.min(remaining, SETUP_MATERIAL_EXCERPT_CHARACTERS));
    remaining -= text.length;
    return {
      ...metadata,
      text,
      ...(text.length < material.text.length
        ? {
            excerpt: `Only ${text.length} of ${material.text.length} characters are included. Do not invent unseen content; the host supplies authorized read-only references separately.`,
          }
        : {}),
    };
  });
}
export function projectSetupAnalysis(): ProjectAnalyzer {
  return {
    id: 'project-setup',
    revision: PROJECT_SETUP_ANALYSIS_REVISION,
    purpose: 'project-setup',
    build: (input) => ({
      instructions:
        'You are the project setup engineer. Inspect the repository only. Do not edit files, start servers, install dependencies, run migrations, mutate Git or deploy. Do not use the network. Do not traverse .buro/, .git/, node_modules/, dist/, build/ or caches, including nested directories. The current profile is supplied in the request. Do not open secrets (.env, keys, local/); .env.example without secret values is allowed. Follow AGENTS.md. Suggest launch commands only, with evidence from actual files; never invent them. Do not start child agents.',
      prompt: `Inspect the project and existing settings. Identify web/api/worker/cli/library/other components, their relative working directories (./ for the root), long-running local launch commands (empty when not applicable), HTTP ports (0 when unknown or non-HTTP), readyPath (empty for non-HTTP), result verification instructions, startup dependencies in instructions, and evidence files. Order components by startup dependency. HTTP commands must accept PORT/HOST or {port}: the service allocates free ports. Each HTTP component address is available as PROJECT_COMPONENT_<UPPERCASE_ID>_URL; use it in commands when a frontend requires an API address. Do not suggest migrations, package installation, production commands or shared database changes. Suggest test/typecheck/lint commands only from existing configuration. Ask about missing variables and infrastructure without including secret values. Describe discovered environments and CI in summary; do not enable delivery automatically. Current profile: preserve manual values during repeated research:\n${JSON.stringify(input.profile)}\nHost-authorized material metadata and text excerpts (reference-only entries are not visual input):\n${JSON.stringify(materialContext(input.materials))}\nReturn the structured result.`,
      schema: z.toJSONSchema(ResearchResultSchema, { target: 'draft-7' }),
    }),
    parse: (text) => JSON.parse(text),
  };
}
export function registerBuiltinProjectAnalyses(catalog: ProjectAnalysisCatalog): void {
  catalog.register(projectSetupAnalysis());
}
export function createBuiltinProjectAnalyses(): ProjectAnalysisCatalog {
  const catalog = new ProjectAnalysisCatalog();
  registerBuiltinProjectAnalyses(catalog);
  return catalog.seal();
}
