/**
 * Built-in strategy registration. Importing this module registers every
 * strategy the CLI can resolve by name. Add new strategies here.
 */
import { registerStrategy } from "../engine/registry.js";
import { noopStrategy } from "./noop.js";
import { microPriceMm } from "./microprice-mm.js";

registerStrategy("noop", () => noopStrategy());
registerStrategy("microprice-mm", () => microPriceMm());
