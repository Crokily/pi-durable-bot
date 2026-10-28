// Check the TLA+ models in spec/ with TLC, the TLA+ model checker.
//
//   npm run tla              every model
//   npm run tla -- Outbox    the configurations of one model
//
// spec/<Model>.cfg and spec/<Model>.<variant>.cfg are configurations of spec/<Model>.tla.
// Needs Java 11 or newer, and tla2tools.jar from https://github.com/tlaplus/tlaplus/releases in $TLA2TOOLS or in
// .tla/tla2tools.jar (git ignores .tla/).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const specDir = join(root, "spec");
const jar = process.env.TLA2TOOLS ?? join(root, ".tla", "tla2tools.jar");
if (!existsSync(jar)) {
  console.error(`no tla2tools.jar at ${jar}. Download it from https://github.com/tlaplus/tlaplus/releases, or set TLA2TOOLS.`);
  process.exit(2);
}
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";

const only = process.argv[2];
const configs = readdirSync(specDir)
  .filter((file) => file.endsWith(".cfg") && (!only || file.split(".")[0] === only))
  .sort();
if (configs.length === 0) {
  console.error(`no configuration for ${only ?? "any model"} in ${specDir}`);
  process.exit(2);
}

let failed = 0;
for (const config of configs) {
  const model = `${config.split(".")[0]}.tla`;
  const meta = mkdtempSync(join(tmpdir(), "tlc-"));
  const started = Date.now();
  const result = spawnSync(
    java,
    ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-cleanup", "-metadir", meta, "-config", config, model],
    { cwd: specDir, encoding: "utf8" },
  );
  rmSync(meta, { recursive: true, force: true });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    const states = /(\d[\d,]*) distinct states found, 0 states left on queue\.\n(?!.*distinct states found)/s.exec(output)?.[1] ?? "?";
    console.log(`ok    ${config}: ${states} distinct states, ${seconds} s`);
  } else {
    failed++;
    console.log(`FAIL  ${config} (exit ${result.status ?? result.error?.message}), ${seconds} s\n${output}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
