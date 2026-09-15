/**
 * 词级文本 diff（4G 欠账清偿：SQL 尝试间的左右对比）。
 *
 * 经典 LCS 动态规划，按空白切词。SQL 尝试通常 <200 token，O(n·m) 完全够。
 * 无依赖、纯函数 —— 服务端组件直接可用。
 */

export interface DiffSegment {
  text: string;
  kind: "same" | "del" | "ins";
}

export interface DiffResult {
  /** 左栏：上一版（相同 + 被删的词） */
  left: DiffSegment[];
  /** 右栏：新版（相同 + 新增的词） */
  right: DiffSegment[];
}

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

export function wordDiff(prev: string, next: string): DiffResult {
  const a = tokenize(prev);
  const b = tokenize(next);
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const left: DiffSegment[] = [];
  const right: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  const push = (arr: DiffSegment[], text: string, kind: DiffSegment["kind"]) => {
    const last = arr[arr.length - 1];
    if (last && last.kind === kind) last.text += text;
    else arr.push({ text, kind });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(left, a[i], "same");
      push(right, b[j], "same");
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(left, a[i], "del");
      i++;
    } else {
      push(right, b[j], "ins");
      j++;
    }
  }
  while (i < n) push(left, a[i++], "del");
  while (j < m) push(right, b[j++], "ins");

  return { left, right };
}
