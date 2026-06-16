/**
 * Research inference — public API for strategies.
 *
 * Usage in a strategy:
 *
 *   import { FeatureState, loadModel, FEATURE_NAMES } from "../research/inference/index.js";
 *
 *   const model = loadModel("research/artifacts/fwd_return_sign_5s.json");
 *   const state = new FeatureState();
 *
 *   // In onTrade:
 *   state.addTrade({ ts, side, price, size });
 *   state.addMid(ts, mid);
 *
 *   // In onBook:
 *   state.prune(now);
 *   const feats = state.compute(book, now);
 *   const prob = model.predict(state.toArray(feats));
 */
export { FeatureState, FEATURE_NAMES } from "./features.js";
export type { FeatureVector, TradeRecord } from "./features.js";
export { GBDTModel, loadModel } from "./model.js";
