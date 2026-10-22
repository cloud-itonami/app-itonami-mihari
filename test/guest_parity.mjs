// wasm parity — test/fixtures/parity.edn を、コンパイル済みの guest
// （aiueos/mihari_core.wasm）に通す。
//
// adapter 側（test/mihari/parity_test.cljk）と guest の test-*（amu test）が
// 同じ表を見ているが、どちらも「wasm 産物そのもの」を実行してはいない。ここは
// 公開する .wasm を amu の typed ホスト（kototama-browser-host-v1 =
// amu/runtime/browser-host.mjs）で読み、表の全行を呼んで照合する。
//
//   node test/guest_parity.mjs [path/to/amu/runtime/browser-host.mjs]
//
// ホストの既定は west レイアウトの ../../kotoba-lang/amu/runtime/browser-host.mjs。
// .wasm の digest は publication sidecar の sha256 と照合してから実行する。
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostPath = resolve(process.argv[2]
  ?? process.env.AMU_BROWSER_HOST
  ?? resolve(root, "../../kotoba-lang/amu/runtime/browser-host.mjs"));
const { instantiateKotoba } = await import(pathToFileURL(hostPath).href);

// --- EDN の小さな部分集合（vector / map / string / keyword / 整数 / コメント） ---
function readEdn(text) {
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (text[i] === ";") { while (i < text.length && text[i] !== "\n") i++; continue; }
      return;
    }
  };
  const form = () => {
    ws();
    const c = text[i];
    if (c === "[" || c === "{") {
      const close = c === "[" ? "]" : "}";
      i++;
      const items = [];
      for (;;) { ws(); if (text[i] === close) { i++; break; } items.push(form()); }
      if (c === "[") return items;
      const m = {};
      for (let k = 0; k < items.length; k += 2) m[items[k]] = items[k + 1];
      return m;
    }
    if (c === "\"") {
      let s = ""; i++;
      while (text[i] !== "\"") { if (text[i] === "\\") i++; s += text[i++]; }
      i++;
      return s;
    }
    const start = i;
    while (i < text.length && !/[\s,\[\]{}]/.test(text[i])) i++;
    const tok = text.slice(start, i);
    if (/^-?\d+$/.test(tok)) return BigInt(tok);
    if (tok.startsWith(":")) return tok;
    throw new Error(`unsupported EDN token: ${tok}`);
  };
  return form();
}

const rows = readEdn(readFileSync(resolve(root, "test/fixtures/parity.edn"), "utf8"));
const wasm = readFileSync(resolve(root, "aiueos/mihari_core.wasm"));
const publication = readFileSync(resolve(root, "aiueos/mihari_core.wasm.publication.edn"), "utf8");
const expectedSha256 = publication.match(/:name "mihari_core\.wasm", :sha256 "([0-9a-f]{64})"/)?.[1];
if (!expectedSha256) throw new Error("publication sidecar has no sha256 for mihari_core.wasm");

const kotoba = await instantiateKotoba(wasm, { expectedSha256 });
const exp = kotoba.instance.exports;
const arg = a => (Array.isArray(a) ? kotoba.typedValues.vectorI64(a) : a);

let pass = 0, fail = 0;
for (const row of rows) {
  const f = exp[row[":fn"]];
  if (typeof f !== "function") { fail++; console.log(`FAIL ${row[":fn"]}: not exported`); continue; }
  const got = f(...row[":args"].map(arg));
  if (got === row[":expect"]) pass++;
  else { fail++; console.log(`FAIL ${row[":fn"]} ${JSON.stringify(row[":args"], (_, v) => typeof v === "bigint" ? Number(v) : v)} => ${got}, expected ${row[":expect"]}`); }
}
console.log(`wasm parity: ${pass}/${rows.length} rows (sha256 ${expectedSha256.slice(0, 12)}…, host ${hostPath})`);
if (fail > 0) process.exitCode = 1;
