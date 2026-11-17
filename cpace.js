'use strict';
(() => {
const enc = new TextEncoder();
const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const D2 = (2n * D) % P;
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;
const SQRT_AD_MINUS_ONE = 25063068953384623474111414158702152701244531502492656460079210482610430750235n;
const INVSQRT_A_MINUS_D = 54469307008909316920995813868745141605393597292927456921205312896311721017578n;
const ONE_MINUS_D_SQ = 1159843021668779879193775521855586647937357759715417654439879720876111806838n;
const D_MINUS_ONE_SQ = 40440834346308536858101042469323190826248399146238708352240133220865137265952n;
const mod = (a) => { const r = a % P; return r < 0n ? r + P : r; };
function pow(b, e) {
let r = 1n;
b = mod(b);
while (e > 0n) {
if (e & 1n) r = (r * b) % P;
b = (b * b) % P;
e >>= 1n;
}
return r;
}
const neg = (a) => mod(-a);
const isNeg = (a) => (mod(a) & 1n) === 1n;
const abs = (a) => (isNeg(a) ? neg(a) : mod(a));
function sqrtRatioM1(u, v) {
u = mod(u);
v = mod(v);
const v3 = mod(v * v * v);
const v7 = mod(v3 * v3 * v);
let r = mod(mod(u * v3) * pow(mod(u * v7), (P - 5n) / 8n));
const check = mod(v * r * r);
const correct = check === u;
const flipped = check === neg(u);
const flippedI = check === mod(neg(u) * SQRT_M1);
if (flipped || flippedI) r = mod(SQRT_M1 * r);
return { square: correct || flipped, r: abs(r) };
}
const le = (bytes) => { let n = 0n; for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]); return n; };
function toLe(n) {
const out = new Uint8Array(32);
for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
return out;
}
const ZERO = [0n, 1n, 1n, 0n];
function add([x1, y1, z1, t1], [x2, y2, z2, t2]) {
const a = mod((y1 - x1) * (y2 - x2));
const b = mod((y1 + x1) * (y2 + x2));
const c = mod(t1 * D2 * t2);
const d = mod(2n * z1 * z2);
const e = b - a, f = d - c, g = d + c, h = b + a;
return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}
function mul(p, n) {
let r0 = ZERO;
let r1 = p;
for (let i = 255n; i >= 0n; i--) {
if ((n >> i) & 1n) { r0 = add(r0, r1); r1 = add(r1, r1); } else { r1 = add(r0, r1); r0 = add(r0, r0); }
}
return r0;
}
function decode(bytes) {
if (bytes.length !== 32) return null;
const s = le(bytes);
if (s >= P || isNeg(s)) return null;
const ss = mod(s * s);
const u1 = mod(1n - ss);
const u2 = mod(1n + ss);
const u2sq = mod(u2 * u2);
const v = mod(neg(D * u1 * u1) - u2sq);
const { square, r: invsqrt } = sqrtRatioM1(1n, mod(v * u2sq));
const denX = mod(invsqrt * u2);
const denY = mod(invsqrt * denX * v);
const x = abs(2n * s * denX);
const y = mod(u1 * denY);
const t = mod(x * y);
if (!square || isNeg(t) || y === 0n) return null;
return [x, y, 1n, t];
}
function encode([x0, y0, z0, t0]) {
const u1 = mod((z0 + y0) * (z0 - y0));
const u2 = mod(x0 * y0);
const { r: invsqrt } = sqrtRatioM1(1n, mod(u1 * u2 * u2));
const den1 = mod(invsqrt * u1);
const den2 = mod(invsqrt * u2);
const zInv = mod(den1 * den2 * t0);
const rotate = isNeg(t0 * zInv);
const x = rotate ? mod(y0 * SQRT_M1) : x0;
let y = rotate ? mod(x0 * SQRT_M1) : y0;
const denInv = rotate ? mod(den1 * INVSQRT_A_MINUS_D) : den2;
if (isNeg(x * zInv)) y = neg(y);
return toLe(abs(denInv * (z0 - y)));
}
function map(t) {
const r = mod(SQRT_M1 * t * t);
const u = mod((r + 1n) * ONE_MINUS_D_SQ);
const v = mod((-1n - r * D) * (r + D));
const { square, r: s0 } = sqrtRatioM1(u, v);
const s = square ? s0 : neg(abs(s0 * t));
const c = square ? P - 1n : r;
const n = mod(c * (r - 1n) * D_MINUS_ONE_SQ - v);
const w0 = mod(2n * s * v);
const w1 = mod(n * SQRT_AD_MINUS_ONE);
const w2 = mod(1n - s * s);
const w3 = mod(1n + s * s);
return [mod(w0 * w3), mod(w2 * w1), mod(w1 * w3), mod(w0 * w2)];
}
const half = (b) => mod(le(b) & ((1n << 255n) - 1n));
const fromUniform = (b64) => add(map(half(b64.subarray(0, 32))), map(half(b64.subarray(32, 64))));
const isZero = (p) => encode(p).every((x) => x === 0);
const concat = (...parts) => {
const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
let i = 0;
for (const p of parts) { out.set(p, i); i += p.length; }
return out;
};
const sha = async (alg, data) => new Uint8Array(await crypto.subtle.digest(alg, data));
const pinKey = (room, pin) => sha('SHA-256', enc.encode(`zd-pin1|${room}|${pin}`));
async function generator(room, sid, pk, label = 'zd-cpace1') {
return fromUniform(await sha('SHA-512', concat(enc.encode(`${label} gen|${room}|${sid}`), pk)));
}
async function begin(label, room, sid, extra, wide) {
const a = le(wide || crypto.getRandomValues(new Uint8Array(64))) % L;
const ya = encode(mul(await generator(room, sid, extra, label), a));
return {
ya,
async finish(yb) {
const p = decode(yb);
if (!p || isZero(p)) return null;
const k = mul(p, a);
if (isZero(k)) return null;
const h = await sha('SHA-512', concat(enc.encode(`${label} isk|${room}|${sid}|`), ya, yb, encode(k)));
return h.subarray(0, 32);
},
};
}
const start = (room, sid, pk, wide) => begin('zd-cpace1', room, sid, pk, wide);
async function askStart(room, sid, wide) {
const run = await begin('zd-ask1', room, sid, new Uint8Array(0), wide);
const commit = await sha('SHA-256', concat(enc.encode(`zd-ask1 commit|${room}|${sid}|`), run.ya));
return {
ya: run.ya,
commit,
async finish(yb) {
const isk = await run.finish(yb);
if (!isk) return null;
const h = await sha('SHA-256', concat(enc.encode('zd-ask1 code|'), isk));
const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
return { isk, code: String(n % 1000000).padStart(6, '0') };
},
};
}
function basepoint() {
const y = mod(4n * pow(5n, P - 2n));
const { r: x } = sqrtRatioM1(mod(y * y - 1n), mod(D * y * y + 1n));
return [x, y, 1n, mod(x * y)];
}
window.ZDCPACE = { pinKey, start, askStart, _g: async (room, sid, pk) => encode(await generator(room, sid, pk)), _basepoint: async () => encode(basepoint()) };
})();
