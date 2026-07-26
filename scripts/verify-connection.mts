/**
 * verify-connection.mts — run the generated client's own self-test, verbatim.
 *
 * SETUP.md §4 step 6: `mint_delivery_token` → `verifyConnection()`.
 * The client snapshot + token come from a prior `npm run spine`.
 *
 *   npm run verify-connection
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "out");

const { token } = JSON.parse(readFileSync(join(OUT, "delivery-token.local.json"), "utf8"));
// @ts-expect-error — generated snapshot, outside the app's tsconfig
const client = await import("./out/agentx-client.ts");
const createClient = client.createClient ?? client.default?.createClient ?? client.default;

const ax = createClient({ token });
const verdict = await ax.verifyConnection();
console.log(typeof verdict === "string" ? verdict : JSON.stringify(verdict, null, 2));
