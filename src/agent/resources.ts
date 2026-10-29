import type { DefaultResourceLoader, Skill } from "@earendil-works/pi-coding-agent";
import { piModule } from "./models.ts";

type BuildSections = (input: {
  customPrompt: string;
  cwd: string;
  contextFiles: { path: string; content: string }[];
  skills: Skill[];
}) => Record<string, string>;

/**
 * pi's context files and skills, found and written the way the pi CLI does: AGENTS.md (or AGENTS.override.md, CLAUDE.md)
 * from pi's agent folder and from the working directory up to the root, and skills from ~/.pi/agent/skills,
 * ~/.agents/skills, the .pi/skills and .agents/skills folders, pi's settings and pi packages. Shared with the pi CLI.
 */
export interface PiResources {
  /** Scan again; then projectContext() and skills() give what is on disk now. */
  reload(): Promise<void>;
  /** pi's <project_context> section, or undefined without context files. */
  projectContext(): string | undefined;
  /** pi's <skills> section, or undefined without skills. */
  skills(): string | undefined;
}

export async function openResources(cwd: string, log: (message: string, data?: Record<string, unknown>) => void): Promise<PiResources> {
  // The modules themselves: the package's index also loads pi's terminal interface.
  const [{ DefaultResourceLoader: Loader }, { buildSystemPromptSections }, { getAgentDir }] = (await Promise.all([
    import(piModule("./core/resource-loader.js")),
    import(piModule("./core/system-prompt.js")),
    import(piModule("./config.js")),
  ])) as [{ DefaultResourceLoader: typeof DefaultResourceLoader }, { buildSystemPromptSections: BuildSections }, { getAgentDir(): string }];
  // Only what a pi session puts in its system prompt; pi's extensions, prompt templates and themes are for its terminal.
  const loader = new Loader({ cwd, agentDir: getAgentDir(), noExtensions: true, noPromptTemplates: true, noThemes: true });
  let sections: Record<string, string> = {};
  let warnings = "";
  const load = async () => {
    await loader.reload();
    const { skills, diagnostics } = loader.getSkills();
    // customPrompt stands for the bot's own sections, which come before these, as a custom system prompt does in pi.
    sections = buildSystemPromptSections({ customPrompt: "-", cwd, contextFiles: loader.getAgentsFiles().agentsFiles, skills });
    const now = diagnostics.map((diagnostic) => `${diagnostic.path ?? ""}: ${diagnostic.message}`).join("\n");
    if (now && now !== warnings) log("skill warnings", { warnings: now });
    warnings = now;
  };
  // A scan that is running serves the calls that come meanwhile.
  let loading: Promise<void> | undefined;
  const resources: PiResources = {
    reload: () => (loading ??= load().finally(() => (loading = undefined))),
    projectContext: () => sections.project_context,
    skills: () => sections.skills,
  };
  await resources.reload();
  return resources;
}
