import { execFileSync } from "node:child_process";

/**
 * Runs `npm <args>` cross-platform and returns stdout.
 *
 * Node cannot execFile the `npm.cmd` shim Windows ships (EINVAL), and
 * `shell: true` with args is deprecated (DEP0190). When running under
 * npm/npx the `npm_execpath` env var points at the real npm-cli.js, so we
 * invoke it via process.execPath — same result, no shell, no .cmd.
 */
export function execNpm(args: readonly string[], options: { cwd?: string } = {}): string {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], { ...options, encoding: "utf8" });
  }
  return execFileSync("npm", args, { ...options, encoding: "utf8" });
}
