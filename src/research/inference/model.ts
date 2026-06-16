/**
 * Model loader + evaluator — loads the custom JSON tree format exported by
 * research/src/train.py and evaluates the GBDT ensemble in pure TypeScript.
 *
 * No ONNX runtime or native dependencies required.
 */
import { readFileSync } from "node:fs";

interface SplitNode {
  f: number;  // feature index
  t: number;  // threshold
  l: number;  // left child index
  r: number;  // right child index
}

interface LeafNode {
  v: number;  // leaf value
}

type TreeNode = SplitNode | LeafNode;

interface Tree {
  nodes: TreeNode[];
}

interface ModelJSON {
  version: number;
  model_type: string;
  objective: string;
  feature_names: string[];
  base_score: number;
  learning_rate: number;
  trees: Tree[];
  metadata?: {
    feature_importance?: Record<string, number>;
    train_metrics?: Record<string, number>;
    test_metrics?: Record<string, number>;
    [key: string]: unknown;
  };
}

function isLeaf(node: TreeNode): node is LeafNode {
  return "v" in node;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class GBDTModel {
  readonly featureNames: string[];
  readonly objective: string;
  readonly metadata: ModelJSON["metadata"];
  private readonly trees: Tree[];
  private readonly baseScore: number;

  constructor(json: ModelJSON) {
    this.featureNames = json.feature_names;
    this.objective = json.objective;
    this.trees = json.trees;
    this.baseScore = json.base_score;
    this.metadata = json.metadata;
  }

  /**
   * Raw prediction — sum of leaf values across all trees + base score.
   * For classification, this is the log-odds (before sigmoid).
   */
  predictRaw(features: number[]): number {
    let score = this.baseScore;
    for (const tree of this.trees) {
      score += this.evalTree(tree, features);
    }
    return score;
  }

  /**
   * Prediction — applies the appropriate transform based on objective.
   * Binary classification → sigmoid (probability).
   * Regression → raw score.
   */
  predict(features: number[]): number {
    const raw = this.predictRaw(features);
    if (this.objective.includes("binary") || this.objective.includes("cross_entropy")) {
      return sigmoid(raw);
    }
    return raw;
  }

  private evalTree(tree: Tree, features: number[]): number {
    let idx = 0;
    while (true) {
      const node = tree.nodes[idx];
      if (isLeaf(node)) return node.v;
      idx = features[node.f] <= node.t ? node.l : node.r;
    }
  }
}

export function loadModel(path: string): GBDTModel {
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw) as ModelJSON;
  if (json.version !== 1) {
    throw new Error(`Unsupported model version: ${json.version}`);
  }
  return new GBDTModel(json);
}
