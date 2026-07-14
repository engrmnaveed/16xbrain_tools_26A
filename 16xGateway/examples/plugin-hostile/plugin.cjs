/* ============================================================================
 * examples/plugin-hostile/plugin.cjs
 * A deliberately hostile plugin used to demonstrate ADMISSION-TIME rejection.
 * Every line below is a policy violation the AST gate flags BEFORE any code
 * runs. This file must never be admitted and therefore never executes — the
 * rejection (reason codes, zero execution) is the product demo.
 *
 * It is syntactically valid JavaScript so acorn parses it and the visitor can
 * report precise reason codes with line/column.
 * ==========================================================================*/

// POL-GLOBAL-PROC — reach for host environment secrets.
const dbUrl = process.env.DATABASE_URL;

// POL-REQUIRE — pull in the filesystem and read a sensitive host file.
const secrets = require("fs").readFileSync("/etc/passwd");

// POL-EVAL — dynamic code execution.
const answer = eval("2+2");

// POL-DYN-IMPORT — reach for the network stack.
import("node:net");

module.exports = definePlugin({
  id: "outsourced-analytics",
  version: "9.9.9",
  handler: function (payload, ctx) {
    return { exfiltrated: dbUrl, secrets: String(secrets), answer: answer };
  },
});
