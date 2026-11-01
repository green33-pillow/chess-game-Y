/* CHESS MIND — AI 체스 코치 (정적 버전)
 * 구성: [1] Stockfish Worker 래퍼  [2] 분석·등급·피드백 로직  [3] UI/대국 흐름
 * chess.js 는 ./vendor/chess.js, Stockfish WASM 은 ./stockfish/ 에서 불러옵니다. */
import { Chess } from "./vendor/chess.js";

/* ═════════════ [1] Stockfish 엔진 ═════════════ */
class Engine {
    constructor() { this.listeners = new Set(); this.rejecters = new Set(); this.queue = Promise.resolve(); this.init(); }
    init() {
        this.w = new Worker("./stockfish/stockfish-nnue-16-single.js");
        this.w.onmessage = (e) => { const l = String(e.data); this.listeners.forEach((f) => f(l)); };
        this.w.onerror = (e) => this.fail(new Error("Stockfish worker error: " + (e.message || "")));
        this.ready = this.waitFor("uciok", () => this.send("uci")).then(() => this.waitFor("readyok", () => this.send("isready"))).then(() => undefined);
        this.ready.catch(() => { });
    }
    fail(err) { this.rejecters.forEach((r) => r(err)); this.rejecters.clear(); this.listeners.clear(); }
    /** 워커가 멈췄을 때 새 워커로 교체 (대기 중인 검색은 reject) */
    reset() { this.fail(new Error("engine reset")); try { this.w.terminate(); } catch (e) { } this.queue = Promise.resolve(); this.init(); }
    send(c) { this.w.postMessage(c); }
    waitFor(token, start) {
        return new Promise((res, rej) => {
            const buf = [];
            const f = (l) => { buf.push(l); if (l.startsWith(token)) { this.listeners.delete(f); this.rejecters.delete(rej); res(buf); } };
            this.listeners.add(f); this.rejecters.add(rej);
            if (start) start();
        });
    }
    run(job) { const p = this.queue.then(() => this.ready).then(job); this.queue = p.catch(() => undefined); return p; }
    /** 검색. 점수는 side-to-move 기준이며 백 기준 변환은 호출 측에서 수행 */
    search(fen, o) {
        return this.run(async () => {
            const t0 = performance.now();
            this.send("ucinewgame");
            this.send(`setoption name Skill Level value ${o.skill ?? 20}`);
            this.send(`setoption name MultiPV value ${o.multipv ?? 1}`);
            this.send(`position fen ${fen}`);
            const go = o.movetime ? `go movetime ${o.movetime}${o.depth ? ` depth ${o.depth}` : ""}` : `go depth ${o.depth ?? 14}`;
            const limit = o.movetime ? o.movetime + 3000 : 45000;
            const stopT = setTimeout(() => this.send("stop"), limit);          // 1차: 정상 종료 요청
            let hardT, lines;
            try {
                lines = await Promise.race([
                    this.waitFor("bestmove", () => this.send(go)),
                    new Promise((_, rej) => { hardT = setTimeout(() => rej(new Error("engine timeout")), limit + 8000); }), // 2차: 워커 교체
                ]);
            } catch (err) { this.reset(); throw err; }
            finally { clearTimeout(stopT); clearTimeout(hardT); }
            const best = new Map();
            for (const l of lines) {
                if (!l.startsWith("info") || !l.includes(" pv ")) continue;
                const d = /depth (\d+)/.exec(l); const mp = /multipv (\d+)/.exec(l);
                const cp = /score cp (-?\d+)/.exec(l); const mt = /score mate (-?\d+)/.exec(l);
                if (!d || (!cp && !mt)) continue;
                const k = mp ? +mp[1] : 1;
                best.set(k, { multipv: k, depth: +d[1], cp: cp ? +cp[1] : null, mate: mt ? +mt[1] : null, pv: l.split(" pv ")[1].trim().split(" ") });
            }
            const arr = [...best.values()].sort((a, b) => a.multipv - b.multipv);
            const bm = lines[lines.length - 1].split(" ")[1];
            if (!arr.length) arr.push({ multipv: 1, cp: 0, mate: null, depth: 0, pv: bm && bm !== "(none)" ? [bm] : [] });
            return { fen, lines: arr, depth: Math.max(...arr.map((x) => x.depth)), ms: Math.round(performance.now() - t0), bestmove: bm && bm !== "(none)" ? bm : null };
        });
    }
    bestMove(fen, o) { return this.search(fen, o).then((a) => a.bestmove); }
    terminate() { this.w.terminate(); }
}

/* ═════════════ [2] 분석 · 등급 · 피드백 ═════════════ */
const GRADES = {
    Brilliant: { ko: "경이로운 수", color: "#2ec4b6", sym: "!!" },
    Great: { ko: "매우 좋은 수", color: "#5b8def", sym: "!" },
    Best: { ko: "최선의 수", color: "#7bc96f", sym: "★" },
    Excellent: { ko: "훌륭한 수", color: "#8fd18a", sym: "✓" },
    Good: { ko: "좋은 수", color: "#a9b8a0", sym: "○" },
    Book: { ko: "이론적으로 알려진 수", color: "#b59a6a", sym: "≡" },
    Inaccuracy: { ko: "부정확한 수", color: "#e6c34a", sym: "?!" },
    Mistake: { ko: "실수", color: "#e8903c", sym: "?" },
    Blunder: { ko: "중대한 실수", color: "#e0524d", sym: "??" },
};
/** 승률 손실(%p) 임계값 — 모든 수에 동일하게 적용 */
const THRESH = { excellent: 2, good: 5, inaccuracy: 10, mistake: 20 };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: "폰", n: "나이트", b: "비숍", r: "룩", q: "퀸", k: "킹" };
const eul = (n) => ((n.charCodeAt(n.length - 1) - 0xac00) % 28 !== 0 ? "을" : "를");
const iga = (n) => ((n.charCodeAt(n.length - 1) - 0xac00) % 28 !== 0 ? "이" : "가");
const CK = (c) => (c === "w" ? "백" : "흑");
const opp = (c) => (c === "w" ? "b" : "w");
const turnOf = (fen) => fen.split(" ")[1];
/* ───────── 평가값 (항상 백 기준) ───────── */
function lineEv(l, turn) {
    const s = turn === "w" ? 1 : -1;
    if (l.mate !== null)
        return { cp: s * (l.mate > 0 ? 10000 - l.mate * 10 : -10000 - l.mate * 10), mate: s * l.mate };
    return { cp: s * (l.cp ?? 0), mate: null };
}
function terminalEv(c) {
    if (c.isCheckmate())
        return { cp: c.turn() === "w" ? -10000 : 10000, mate: 0, over: "mate" };
    if (c.isDraw() || c.isStalemate())
        return { cp: 0, mate: null, over: "draw" };
    return null;
}
function winPct(ev, color) {
    if (ev.over === "draw")
        return 50;
    const white = ev.mate !== null ? (ev.over === "mate" ? (ev.cp > 0 ? 1 : -1) : ev.mate > 0 ? 1 : -1) : 0;
    if (ev.mate !== null)
        return (color === "w" ? white : -white) > 0 ? 100 : 0;
    const cp = Math.max(-1000, Math.min(1000, color === "w" ? ev.cp : -ev.cp));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}
function fmtEv(ev) {
    if (ev.over === "mate")
        return "체크메이트";
    if (ev.over === "draw")
        return "0.00";
    if (ev.mate !== null)
        return `${ev.mate > 0 ? "+" : "-"}M${Math.abs(ev.mate)}`;
    return `${ev.cp >= 0 ? "+" : ""}${(ev.cp / 100).toFixed(2)}`;
}
function describeEv(ev) {
    if (ev.over === "mate")
        return `${ev.cp > 0 ? "백" : "흑"} 승리(체크메이트)`;
    if (ev.over === "draw")
        return "무승부";
    if (ev.mate !== null)
        return `${ev.mate > 0 ? "백" : "흑"}의 강제 메이트(${Math.abs(ev.mate)}수 이내)`;
    const a = Math.abs(ev.cp), side = ev.cp > 0 ? "백" : "흑";
    if (a < 30)
        return "거의 균형";
    if (a < 100)
        return `${side} 약간 우세`;
    if (a < 250)
        return `${side} 우세`;
    return `${side} 크게 우세`;
}
/* ───────── 오프닝 북 (SAN 접두사 일치) ───────── */
const BOOK = [
    ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", "루이 로페즈 (클로즈드)"], ["e4 e5 Nf3 Nc6 Bb5", "루이 로페즈"], ["e4 e5 Nf3 Nc6 Bc4 Bc5", "이탈리안 게임 (지우오코 피아노)"],
    ["e4 e5 Nf3 Nc6 Bc4 Nf6", "투 나이츠 디펜스"], ["e4 e5 Nf3 Nc6 d4 exd4 Nxd4", "스코치 게임"], ["e4 e5 Nf3 Nc6 Nc3 Nf6", "포 나이츠 게임"],
    ["e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4", "페트로프 디펜스"], ["e4 e5 Bc4", "비숍 오프닝"], ["e4 e5 Nf3 d6", "필리도르 디펜스"],
    ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3", "시칠리안 (나이도르프/드래곤 계열)"], ["e4 c5 Nf3 Nc6 d4 cxd4 Nxd4", "시칠리안 오픈"], ["e4 c5 Nf3 e6 d4 cxd4 Nxd4", "시칠리안 오픈"],
    ["e4 c5 Nc3", "시칠리안 클로즈드"], ["e4 c5 c3", "시칠리안 알라핀"], ["e4 e6 d4 d5 Nc3", "프렌치 디펜스"], ["e4 e6 d4 d5 e5", "프렌치 어드밴스"],
    ["e4 c6 d4 d5 Nc3 dxe4 Nxe4", "카로칸 디펜스"], ["e4 c6 d4 d5 e5", "카로칸 어드밴스"], ["e4 d5 exd5 Qxd5 Nc3 Qa5", "스칸디나비안 디펜스"], ["e4 d6 d4 Nf6 Nc3 g6", "피르츠 디펜스"],
    ["d4 d5 c4 e6 Nc3 Nf6", "퀸즈 갬빗 거절"], ["d4 d5 c4 dxc4", "퀸즈 갬빗 수락"], ["d4 d5 c4 c6", "슬라브 디펜스"],
    ["d4 Nf6 c4 g6 Nc3 Bg7 e4 d6", "킹스 인디언 디펜스"], ["d4 Nf6 c4 e6 Nc3 Bb4", "님조-인디언 디펜스"], ["d4 Nf6 c4 e6 Nf3 b6", "퀸즈 인디언 디펜스"],
    ["d4 Nf6 Bg5", "트롬포프스키 공격"], ["d4 d5 Nf3 Nf6 Bf4", "런던 시스템"], ["d4 Nf6 Nf3 g6 Bf4", "런던 시스템"], ["d4 d5 Bf4", "런던 시스템"],
    ["c4 e5 Nc3 Nf6", "잉글리시 오프닝"], ["c4 Nf6 Nc3 e6", "잉글리시 오프닝"], ["c4 c5", "대칭 잉글리시"], ["Nf3 d5 g3", "레티 오프닝"], ["Nf3 Nf6 c4", "레티/잉글리시"], ["Nf3 d5 d4", "레티 → 퀸즈 폰 계열"],
    ["e4 e5 Nf3 Nc6 Nc3", "비엔나/프로시안 계열"], ["d4 Nf6 c4 e6 g3", "카탈루냐 오프닝"], ["d4 d5 c4 e6 Nf3", "퀸즈 갬빗"], ["d4 Nf6", "인디언 디펜스"], ["d4 d5", "퀸즈 폰 오프닝"], ["e4 e5", "오픈 게임"], ["e4 c5", "시칠리안 디펜스"], ["Nf3", "레티 오프닝"], ["c4", "잉글리시 오프닝"], ["d4", "퀸즈 폰 오프닝"], ["e4", "킹스 폰 오프닝"],
];
function bookName(sans) {
    if (sans.length > 14)
        return undefined;
    const clean = sans.map((s) => s.replace(/[+#]/g, ""));
    let best;
    for (const [line, name] of BOOK) {
        const l = line.split(" ");
        if (l.length < clean.length)
            continue;
        if (clean.every((m, i) => l[i] === m)) {
            if (!best || l.length < best[1])
                best = [name, l.length];
        }
    }
    return best?.[0];
}
/* ───────── 포지션 지표 ───────── */
const CENTER = ["d4", "e4", "d5", "e5"];
function centerControl(c, color) {
    let s = 0;
    for (const sq of CENTER) {
        s += c.attackers(sq, color).length;
        const p = c.get(sq);
        if (p && p.color === color && p.type === "p")
            s += 1;
    }
    return s;
}
function mobility(fen, color) {
    const p = fen.split(" ");
    p[1] = color;
    p[3] = "-";
    try {
        return new Chess(p.join(" "), { skipValidation: true }).moves().length;
    }
    catch {
        return 0;
    }
}
function material(c, color) {
    let s = 0;
    for (const r of c.board())
        for (const p of r)
            if (p && p.color === color)
                s += VAL[p.type];
    return s;
}
function kingSq(c, color) {
    for (const r of c.board())
        for (const p of r)
            if (p && p.type === "k" && p.color === color)
                return p.square;
    return null;
}
const sqAt = (f, r) => (String.fromCharCode(97 + f) + (r + 1));
function kingSafety(c, color) {
    const k = kingSq(c, color);
    if (!k)
        return { score: 0, label: "-", shield: 0, attacked: 0, castled: false };
    const f = k.charCodeAt(0) - 97, r = +k[1] - 1, enemy = opp(color), dir = color === "w" ? 1 : -1;
    let attacked = 0, shield = 0;
    for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
            const nf = f + dx, nr = r + dy;
            if (nf < 0 || nf > 7 || nr < 0 || nr > 7 || (!dx && !dy))
                continue;
            if (c.attackers(sqAt(nf, nr), enemy).length > 0)
                attacked++;
        }
    for (let dx = -1; dx <= 1; dx++)
        for (const st of [1, 2]) {
            const nf = f + dx, nr = r + dir * st;
            if (nf < 0 || nf > 7 || nr < 0 || nr > 7)
                continue;
            const p = c.get(sqAt(nf, nr));
            if (p && p.type === "p" && p.color === color)
                shield += st === 1 ? 1 : 0.5;
        }
    const castled = r === (color === "w" ? 0 : 7) && (f >= 6 || f <= 2);
    const score = shield + (castled ? 1 : 0) - 1.5 * attacked;
    return { score, label: score >= 3 ? "안전" : score >= 0.5 ? "보통" : "위험", shield, attacked, castled };
}
function hanging(c, color) {
    const out = [], enemy = opp(color);
    for (const row of c.board())
        for (const p of row) {
            if (!p || p.color !== color || p.type === "k")
                continue;
            const atk = c.attackers(p.square, enemy);
            if (!atk.length)
                continue;
            const def = c.attackers(p.square, color).length;
            const minAtk = Math.min(...atk.map((s) => { const t = c.get(s).type; return t === "k" ? 99 : VAL[t]; }));
            if (def === 0)
                out.push({ sq: p.square, type: p.type, why: "보호받지 못함" });
            else if (minAtk < VAL[p.type])
                out.push({ sq: p.square, type: p.type, why: "더 낮은 가치의 기물에게 공격받음" });
        }
    return out;
}
const hs = (h) => `${NAME[h.type]}(${h.sq})`;
/* ───────── 수 표기 ───────── */
function uciMove(u) { return { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }; }
function pvToSan(fen, pv, n = 5) {
    const c = new Chess(fen), out = [];
    for (const u of pv.slice(0, n)) {
        try {
            out.push(c.move(uciMove(u)).san);
        }
        catch {
            break;
        }
    }
    return out;
}
function toCands(a) {
    const t = turnOf(a.fen);
    return a.lines.filter((l) => l.pv.length).map((l) => { const s = pvToSan(a.fen, l.pv, 5); return { san: s[0] ?? l.pv[0], uci: l.pv[0], ev: lineEv(l, t), pv: s }; });
}
/* ───────── 수의 특징 추출 ───────── */
function describe(beforeFen, m, afterFen, ply) {
    const before = new Chess(beforeFen), after = new Chess(afterFen), me = m.color, enemy = opp(me);
    const purpose = [], pros = [];
    const mob0 = mobility(beforeFen, me), mob1 = mobility(afterFen, me);
    const cc0 = centerControl(before, me), cc1 = centerControl(after, me);
    const ks0 = kingSafety(before, me), ks1 = kingSafety(after, me);
    const isCastle = m.isKingsideCastle() || m.isQueensideCastle();
    if (isCastle)
        purpose.push("캐슬링으로 킹을 안전한 구석으로 옮기고 룩을 중앙 쪽으로 연결합니다.");
    if (m.captured)
        purpose.push(`${NAME[m.captured]}${eul(NAME[m.captured])} 잡아 ${VAL[m.captured] > VAL[m.piece] ? "기물 가치상 이득" : VAL[m.captured] === VAL[m.piece] ? "동가 교환" : "교환"}을 만듭니다 (잡은 가치 ${VAL[m.captured]}, 움직인 ${NAME[m.piece]} ${VAL[m.piece]}).`);
    if (m.promotion)
        purpose.push(`폰을 ${NAME[m.promotion]}(으)로 승급시킵니다.`);
    if (after.inCheck())
        purpose.push(`${after.isCheckmate() ? "체크메이트로 게임을 끝냅니다." : "체크로 상대의 응수를 강제합니다."}`);
    if ((m.piece === "n" || m.piece === "b") && ply <= 24 && m.from[1] === (me === "w" ? "1" : "8"))
        purpose.push(`${NAME[m.piece]}${eul(NAME[m.piece])} 초기 위치에서 전개해 기물 활동을 시작합니다.`);
    if (CENTER.includes(m.to) && !m.captured)
        purpose.push(`${m.to} 중앙 칸을 직접 차지합니다.`);
    else if (cc1 > cc0)
        purpose.push(`중앙 4칸에 대한 영향력을 늘립니다 (통제 지표 ${cc0} → ${cc1}).`);
    if (m.piece === "p" && !m.captured && !CENTER.includes(m.to) && !m.promotion)
        purpose.push("폰 전진으로 공간을 넓히고 기물의 길을 엽니다.");
    if (m.piece !== "k") {
        const tg = [];
        for (const row of after.board())
            for (const p of row) {
                if (!p || p.color !== enemy || p.type === "k")
                    continue;
                if (after.attackers(p.square, me).includes(m.to)) {
                    const def = after.attackers(p.square, enemy).length;
                    if (def === 0 || VAL[p.type] > VAL[m.piece])
                        tg.push(`${NAME[p.type]}(${p.square})`);
                }
            }
        if (tg.length)
            purpose.push(`${NAME[m.piece]}의 공격 대상: ${tg.join(", ")}.`);
    }
    if (mob1 - mob0 >= 3)
        pros.push(`내 기물의 이동 가능 수가 ${mob0} → ${mob1}로 늘어 활동성이 좋아집니다.`);
    if (cc1 > cc0)
        pros.push(`중앙 통제 지표가 ${cc0} → ${cc1}로 상승합니다.`);
    if (ks1.score > ks0.score + 0.9)
        pros.push(`킹 안전 지표가 ${ks0.score.toFixed(1)} → ${ks1.score.toFixed(1)}로 개선됩니다 (${ks0.label} → ${ks1.label}).`);
    if (m.captured && VAL[m.captured] >= VAL[m.piece])
        pros.push(`기물 가치 ${VAL[m.captured]}를 얻습니다.`);
    if (after.inCheck() && !after.isCheckmate())
        pros.push("체크로 템포를 유지합니다.");
    return { purpose, pros, mob0, mob1, cc0, cc1, ks0, ks1, before, after, isCastle };
}
function isSacrifice(m, after) {
    if (m.piece === "p" || m.piece === "k" || VAL[m.piece] < 3)
        return false;
    const enemy = opp(m.color), atk = after.attackers(m.to, enemy);
    if (!atk.length)
        return false;
    const minAtk = Math.min(...atk.map((s) => { const t = after.get(s).type; return t === "k" ? 99 : VAL[t]; }));
    const def = after.attackers(m.to, m.color).length;
    const gain = m.captured ? VAL[m.captured] : 0;
    return (def === 0 || minAtk < VAL[m.piece]) && VAL[m.piece] - gain >= 2;
}
/* ───────── 사용자 수 평가 ───────── */
function evaluateUserMove(args) {
    const { prev, post, postEv, move: m, ply, sans } = args;
    const me = m.color, f = describe(m.before, m, m.after, ply);
    const prevLines = prev.lines.filter((l) => l.pv.length);
    const best = prevLines[0], second = prevLines[1];
    const uci = m.from + m.to + (m.promotion ?? "");
    const matchIdx = prevLines.findIndex((l) => l.pv[0] === uci);
    const evBefore = lineEv(best, me);
    const evAfter = matchIdx >= 0 ? lineEv(prevLines[matchIdx], me) : postEv;
    const wBefore = winPct(evBefore, me), wAfter = winPct(evAfter, me);
    const loss = Math.max(0, wBefore - wAfter);
    const bestSan = pvToSan(m.before, best.pv, 1)[0] ?? null;
    const isTop = matchIdx === 0;
    const opening = bookName(sans);
    let grade;
    const gap = second ? wBefore - winPct(lineEv(second, me), me) : 0;
    if (isTop || loss <= 0.5) {
        if (isSacrifice(m, f.after) && wAfter >= 45 && wBefore < 90 && loss <= THRESH.excellent)
            grade = "Brilliant";
        else if (second && gap >= 12 && wBefore < 97 && wBefore > 20)
            grade = "Great";
        else if (opening && ply <= 14)
            grade = "Book";
        else
            grade = "Best";
    }
    else if (opening && loss <= 8 && ply <= 14)
        grade = "Book";
    else if (loss <= THRESH.excellent)
        grade = "Excellent";
    else if (loss <= THRESH.good)
        grade = "Good";
    else if (loss <= THRESH.inaccuracy)
        grade = "Inaccuracy";
    else if (loss <= THRESH.mistake)
        grade = "Mistake";
    else
        grade = "Blunder";
    const L = loss.toFixed(1), d = prev.depth;
    const verdict = {
        Brilliant: `기물을 내주는 것처럼 보이지만 엔진 평가를 유지하는 수입니다 (승률 손실 ${L}%p).`,
        Great: `핵심이 되는 수를 찾았습니다. 2순위 후보보다 승률이 ${gap.toFixed(1)}%p 높습니다.`,
        Best: `엔진 1순위 수와 일치합니다.`,
        Excellent: `엔진 최선과 승률 차이가 ${L}%p로 사실상 동급입니다.`,
        Good: `엔진 최선보다 승률이 ${L}%p 낮지만 무리 없는 수입니다.`,
        Book: `${opening ?? "오프닝"} 계열의 알려진 전개입니다 (엔진 최선 대비 ${L}%p).`,
        Inaccuracy: `엔진 최선보다 승률이 ${L}%p 낮습니다. 더 나은 선택지가 있었습니다.`,
        Mistake: `엔진 최선보다 승률이 ${L}%p 낮아 형세가 눈에 띄게 나빠집니다.`,
        Blunder: `엔진 최선보다 승률이 ${L}%p 낮아 형세를 크게 해치는 수입니다.`,
    }[grade];
    const missed = [], weak = [];
    const hangBefore = hanging(f.before, me).map((h) => h.sq), hangAfter = hanging(f.after, me);
    const replyU = post?.lines[0]?.pv[0] ?? null;
    const replySan = post && replyU ? pvToSan(m.after, post.lines[0].pv, 1)[0] : null;
    const replyMove = replyU ? (() => { try {
        return new Chess(m.after).move(uciMove(replyU));
    }
    catch {
        return null;
    } })() : null;
    if (loss > THRESH.excellent && bestSan) {
        missed.push(`엔진이 고른 최선은 ${bestSan}(평가 ${fmtEv(evBefore)})였고, 실제 수 후 평가는 ${fmtEv(evAfter)}입니다.`);
        if (best.mate !== null && best.mate > 0)
            missed.push(`${bestSan}으로 시작하는 ${best.mate}수 메이트가 있었습니다.`);
        const bm = (() => { try {
            return new Chess(m.before).move(uciMove(best.pv[0]));
        }
        catch {
            return null;
        } })();
        if (bm?.captured)
            missed.push(`${bestSan}은(는) ${NAME[bm.captured]}${eul(NAME[bm.captured])} 잡는 수였습니다.`);
        else if (bm && new Chess(bm.after).inCheck())
            missed.push(`${bestSan}은(는) 체크를 주며 주도권을 가져오는 수였습니다.`);
    }
    if (evAfter.mate !== null && ((me === "w") === (evAfter.mate < 0)) && !evAfter.over)
        missed.push(`이 수 이후 상대에게 ${Math.abs(evAfter.mate)}수 이내 강제 메이트가 생깁니다.`);
    const newHang = hangAfter.filter((h) => !hangBefore.includes(h.sq));
    if (newHang.length)
        missed.push(`${newHang.map(hs).join(", ")}이(가) ${newHang[0].why} 상태가 되었습니다.`);
    if (f.ks1.score < f.ks0.score - 1.4)
        missed.push(`킹 주변 안전 지표가 ${f.ks0.score.toFixed(1)} → ${f.ks1.score.toFixed(1)}로 낮아졌습니다 (${f.ks0.label} → ${f.ks1.label}).`);
    if (!missed.length)
        missed.push(grade === "Blunder" || grade === "Mistake" || grade === "Inaccuracy" ? "단일 원인으로 특정되지 않는 평가 하락입니다. 위 엔진 최선과 비교해 보세요." : `분석 깊이 ${d} 범위에서 뚜렷한 간과는 발견되지 않았습니다.`);
    if (replyMove && replySan && !post?.lines[0].mate) {
        if (replyMove.captured)
            weak.push(`상대의 엔진 최선 응수 ${replySan}은(는) ${NAME[replyMove.captured]}${eul(NAME[replyMove.captured])} 잡습니다.`);
        else if (new Chess(replyMove.after).inCheck())
            weak.push(`상대의 엔진 최선 응수 ${replySan}은(는) 체크로 시작합니다.`);
    }
    if (post?.lines[0].mate !== null && post?.lines[0].mate !== undefined && post.lines[0].mate > 0)
        weak.push(`상대에게 ${post.lines[0].mate}수 메이트 라인이 있습니다 (${pvToSan(m.after, post.lines[0].pv, 4).join(" ")}).`);
    if (hangAfter.length)
        weak.push(`${hangAfter.map(hs).join(", ")}이(가) 공격 대상입니다.`);
    if (f.ks1.attacked >= 2)
        weak.push(`킹 주변 ${f.ks1.attacked}칸이 상대 기물의 공격 범위에 있습니다.`);
    if (!weak.length)
        weak.push(`분석 깊이 ${d} 안에서 상대가 즉시 활용할 뚜렷한 약점은 없습니다.`);
    const impact = `수 이후 평가 ${fmtEv(evAfter)} (${describeEv(evAfter)}, 백 기준). 이 수로 ${CK(me)} 승률은 ${wBefore.toFixed(0)}% → ${wAfter.toFixed(0)}%로 이동했습니다.`;
    return {
        grade, lossPct: loss, evBefore, evAfter, bestSan, verdict,
        purpose: f.purpose.length ? f.purpose : ["뚜렷한 전술·전개 목적이 확인되지 않는 수입니다 (활동성 지표 변화 " + (f.mob1 - f.mob0) + ")."],
        pros: f.pros.length ? f.pros : ["지표상 두드러진 이점은 없습니다."], missed, weaknesses: weak, impact,
        depth: d, ms: prev.ms, opening: grade === "Book" ? opening : undefined, candidates: [],
    };
}
/* ───────── AI 수 설명 ───────── */
function explainAIMove(args) {
    const { prev, postAI, postEv, move: m, ply, userMove: um, userGrade, skillNote } = args;
    const f = describe(m.before, m, m.after, ply), me = m.color;
    const lines = prev.lines.filter((l) => l.pv.length), uci = m.from + m.to + (m.promotion ?? "");
    const idx = lines.findIndex((l) => l.pv[0] === uci);
    const evBest = lineEv(lines[0], me), evPlayed = idx >= 0 ? lineEv(lines[idx], me) : postEv;
    const loss = Math.max(0, winPct(evBest, me) - winPct(evPlayed, me));
    const bestSan = pvToSan(m.before, lines[0].pv, 1)[0];
    const reason = [];
    if (idx === 0)
        reason.push(`엔진이 계산한 1순위 수입니다 (평가 ${fmtEv(evPlayed)}, ${describeEv(evPlayed)}).`);
    else if (idx > 0)
        reason.push(`엔진 ${idx + 1}순위 후보입니다 (탐색 평가 ${fmtEv(evPlayed)}). 1순위 ${bestSan}와 승률 차 ${loss.toFixed(1)}%p입니다. ${skillNote}`);
    else
        reason.push(`엔진 상위 후보에는 없는 수입니다. 최선은 ${bestSan}(${fmtEv(evBest)})이며 승률 차는 ${loss.toFixed(1)}%p입니다. ${skillNote}`);
    let link = "직전 수와 직접적 전술 연관은 확인되지 않았습니다.";
    if (um) {
        if (m.captured && m.to === um.to)
            link = `방금 둔 ${NAME[um.piece]}(${um.to})을(를) 직접 잡는 응수입니다.`;
        else if (new Chess(m.after).inCheck())
            link = `당신의 ${um.san}에 체크로 응수해 주도권을 가져옵니다.`;
        else
            link = `당신의 ${um.san}${userGrade ? `(${GRADES[userGrade].ko})` : ""} 이후 엔진 평가가 ${fmtEv(lineEv(lines[0], me))}(백 기준)인 포지션에서 둔 응수입니다.`;
    }
    const threat = f.purpose.filter((p) => p.includes("공격 대상") || p.includes("체크"));
    const pvs = postAI ? pvToSan(m.after, postAI.lines[0].pv, 4) : [];
    if (!threat.length)
        threat.push("이 수로 생긴 즉각적인 위협은 확인되지 않습니다.");
    return {
        san: m.san, pieceKo: NAME[m.piece], matchesBest: idx === 0, lossPct: loss, reason, link,
        purpose: f.purpose.length ? f.purpose : [`기물 재배치 (이동 가능 수 ${f.mob0} → ${f.mob1}).`], threat, pvSan: pvs,
        evAfter: postEv, depth: prev.depth, ms: prev.ms,
    };
}
function positionReport(a) {
    const c = new Chess(a.fen), t = c.turn(), cands = toCands(a), ev = cands[0]?.ev ?? { cp: 0, mate: null };
    const w = { material: material(c, "w"), mob: mobility(a.fen, "w"), center: centerControl(c, "w"), king: kingSafety(c, "w"), hang: hanging(c, "w") };
    const b = { material: material(c, "b"), mob: mobility(a.fen, "b"), center: centerControl(c, "b"), king: kingSafety(c, "b"), hang: hanging(c, "b") };
    const strategy = [], me = t, you = opp(t), S = { w, b };
    const wp = winPct(ev, me);
    strategy.push(wp > 65 ? `${CK(me)}이(가) 유리합니다(${fmtEv(ev)}). 교환으로 단순화하며 우위를 굳히는 계획이 알맞습니다.` : wp < 35 ? `${CK(me)}이(가) 불리합니다(${fmtEv(ev)}). 복잡한 포지션을 만들고 상대 실수를 유도해야 합니다.` : `형세가 팽팽합니다(${fmtEv(ev)}). 기물 활동성과 구조 개선으로 장기전을 준비합니다.`);
    if (S[you].king.label === "위험")
        strategy.push(`${CK(you)} 킹이 위험한 상태입니다(안전 지표 ${S[you].king.score.toFixed(1)}). 킹 쪽으로 공격을 전개할 가치가 있습니다.`);
    if (S[me].king.label === "위험")
        strategy.push(`${CK(me)} 킹이 위험한 상태입니다. 캐슬링이나 방어 기물 보강이 우선입니다.`);
    if (S[me].center < S[you].center - 1)
        strategy.push(`중앙 통제에서 뒤져 있습니다 (${S[me].center} vs ${S[you].center}). 중앙 폰 돌파나 기물 배치로 반박하는 것을 고려하세요.`);
    const total = S.w.material + S.b.material;
    if (total <= 26)
        strategy.push("기물이 많이 줄었습니다. 엔드게임에서는 킹 활성화와 통과 폰이 중요합니다.");
    if (S[me].mob < S[you].mob - 6)
        strategy.push(`이동 가능 수가 상대보다 적습니다 (${S[me].mob} vs ${S[you].mob}). 갇힌 기물을 풀어 주세요.`);
    return { turn: t, ev, material: { w: w.material, b: b.material }, mob: { w: w.mob, b: b.mob }, center: { w: w.center, b: b.center }, king: { w: w.king, b: b.king }, hang: { w: w.hang, b: b.hang }, strategy, cands, depth: a.depth, ms: a.ms };
}
function answerQuestion(q, r) {
    const t = q.toLowerCase(), side = CK(r.turn), dn = `분석 깊이 ${r.depth}`;
    const kingTxt = `킹 안전: 백 ${r.king.w.label}(${r.king.w.score.toFixed(1)}), 흑 ${r.king.b.label}(${r.king.b.score.toFixed(1)}).`;
    const cand = r.cands.map((c, i) => `${i + 1}. ${c.san} (${fmtEv(c.ev)}) — ${c.pv.join(" ")}`).join("\n");
    if (/최선|추천|후보|뭘 둬|어떤 수|다음/.test(t))
        return `${side} 차례, 엔진 후보 (${dn}, 백 기준 평가):\n${cand}`;
    if (/킹|안전/.test(t))
        return `${kingTxt}\n킹 주변 공격받는 칸 — 백 ${r.king.w.attacked}, 흑 ${r.king.b.attacked}. 캐슬링 여부 — 백 ${r.king.w.castled ? "완료" : "미완"}, 흑 ${r.king.b.castled ? "완료" : "미완"}.`;
    if (/중앙/.test(t))
        return `중앙(d4·e4·d5·e5) 통제 지표: 백 ${r.center.w}, 흑 ${r.center.b}. ${r.center.w === r.center.b ? "동률입니다." : `${r.center.w > r.center.b ? "백" : "흑"}이 앞섭니다.`}`;
    if (/위협|공격|전술|hanging|노출/.test(t)) {
        const hh = (x) => (x.length ? x.map(hs).join(", ") : "없음");
        return `취약한 기물 — 백: ${hh(r.hang.w)} / 흑: ${hh(r.hang.b)}.\n엔진 주 변화: ${r.cands[0]?.pv.join(" ") ?? "-"} (${dn}).`;
    }
    if (/전략|계획|플랜|어떻게/.test(t))
        return r.strategy.join("\n");
    if (/활동|가치|기물/.test(t))
        return `기물 가치 합: 백 ${r.material.w}, 흑 ${r.material.b} (폰1·나이트/비숍3·룩5·퀸9).\n이동 가능 수(활동성): 백 ${r.mob.w}, 흑 ${r.mob.b}.`;
    if (/유리|평가|누가|형세|승/.test(t))
        return `평가 ${fmtEv(r.ev)} (백 기준) — ${describeEv(r.ev)}. ${dn}, 계산 ${r.ms}ms. 깊이가 낮을수록 평가는 달라질 수 있습니다.`;
    return `${side} 차례. 평가 ${fmtEv(r.ev)} (${describeEv(r.ev)}).\n${r.strategy[0]}\n${kingTxt}\n(질문 예: 최선의 수, 킹 안전, 중앙, 위협, 전략, 활동성)`;
}

/* ═════════════ UI / 대국 흐름 ═════════════ */
const LEVELS = [
  { ko: "초보자", skill: 0, depth: 1, ms: 50 }, { ko: "쉬움", skill: 3, depth: 3, ms: 100 }, { ko: "보통", skill: 8, depth: 6, ms: 300 },
  { ko: "어려움", skill: 14, depth: 10, ms: 800 }, { ko: "전문가", skill: 20, depth: 16, ms: 1500 }, { ko: "마스터", skill: 20, depth: 24, ms: 3500 },
];
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GLYPH = { k: "\u265A", q: "\u265B", r: "\u265C", b: "\u265D", n: "\u265E", p: "\u265F" };
const FILES = "abcdefgh";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtClock = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

const S = { setup: true, color: "w", lvl: 2, minutes: 10, adepth: 14, recs: [], fens: [START], view: 0, busy: "", ready: false, result: "",
  clock: [0, 0], thinking: false, analyzing: 0, error: "", hint: null, arrows: true, tab: "coach", report: null, reportFen: "", chat: [], sel: null, promo: null, drag: null };
let chess = new Chess(), play = null, ana = null, gid = 0, pre = null, over = false;

const analyze = (fen) => ana.search(fen, { depth: S.adepth, movetime: 8000, multipv: 3 }); // 8초 상한: 느린 기기 보호
const lvlInfo = () => LEVELS[S.lvl];
const isLive = () => S.view === S.fens.length - 1;
const userTurn = () => !S.setup && !S.result && isLive() && !S.thinking && !S.error && chess.turn() === S.color && !!preP;
const badge = (g) => `<span class="badge" style="background:${GRADES[g].color}26;color:${GRADES[g].color}">${GRADES[g].sym} ${g}</span>`;
const sec = (t, items) => `<div class="sec"><h4>${t}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`;

function endText(c) {
  if (c.isCheckmate()) return `체크메이트 — ${c.turn() === "w" ? "흑" : "백"} 승리`;
  if (c.isStalemate()) return "스테일메이트 — 무승부";
  if (c.isThreefoldRepetition()) return "3회 반복 — 무승부";
  if (c.isInsufficientMaterial()) return "기물 부족 — 무승부";
  if (c.isDrawByFiftyMoves()) return "50수 규칙 — 무승부";
  return "무승부";
}
function finish(text) { over = true; S.result = text; S.thinking = false; S.busy = ""; S.tab = "review"; render(); }
function pushRec(r, fen) { S.recs.push(r); S.fens.push(fen); S.view = S.fens.length - 1; }
const patchRec = (ply, f) => { S.recs = S.recs.map((r) => (r.ply === ply ? f(r) : r)); };

let preP = null, retryFn = null;   // preP: 현재 포지션(내 차례) 분석 Promise
const track = async (p) => { S.analyzing++; render(); try { return await p; } finally { S.analyzing--; render(); } };
const errMsg = (e) => String((e && e.message) || e);

/** AI 차례. 수 계산은 코치 분석과 병렬로 진행하고, 설명은 수를 둔 뒤 비동기로 채웁니다. */
async function doAI(g, prevP, ctx) {
  if (chess.isGameOver()) return;
  S.thinking = true; S.hint = null; S.error = ""; retryFn = null; render();
  const fen = chess.fen(), L = lvlInfo(); let bm = null;
  for (let i = 0; i < 2 && !bm; i++) {
    try { bm = await play.bestMove(fen, { skill: L.skill, depth: L.depth, movetime: L.ms }); }
    catch (e) { console.warn("AI 검색 실패, 엔진 재시작", e); if (g !== gid) return; play.reset(); }
    if (g !== gid || over) return;
  }
  if (g !== gid || over) return;
  let m = null; try { m = bm ? chess.move(uciMove(bm)) : null; } catch (e) { m = null; }
  S.thinking = false;
  if (!m) { S.error = "AI 엔진이 응답하지 않았습니다."; retryFn = () => doAI(g, prevP, ctx); render(); return; }
  const ply = chess.history().length, term = terminalEv(chess), lastEv = S.recs.length ? S.recs[S.recs.length - 1].ev : { cp: 0, mate: null };
  pushRec({ ply, side: "ai", san: m.san, uci: bm, from: m.from, to: m.to, ev: term || lastEv }, m.after);
  if (!term) { preP = analyze(m.after); preP.catch(() => { }); }   // 다음 내 수의 기준 분석
  render();
  const explain = (async () => {
    try {
      const [prev, post] = await track(Promise.all([prevP, term ? Promise.resolve(null) : preP]));
      if (g !== gid) return;
      const ev = term || lineEv(post.lines[0], turnOf(m.after));
      const fb = ctx.fbP ? await ctx.fbP : null;
      const L2 = lvlInfo(), note = L2.skill < 20 || L2.depth < 16 ? `난이도 '${L2.ko}'(Skill ${L2.skill}, 탐색 깊이 ≤${L2.depth})로 일부러 약화되어 있어 최선이 아닐 수 있습니다.` : "";
      const ai = explainAIMove({ prev, postAI: post, postEv: ev, move: m, ply, userMove: ctx.userMove, userGrade: fb ? fb.grade : undefined, skillNote: note });
      patchRec(ply, (r) => ({ ...r, ev, ai }));
      if (post) {
        if (chess.history().length === ply) S.hint = post;
        const cands = toCands(post);
        if (ply > 1) patchRec(ply - 1, (r) => (r.fb ? { ...r, fb: { ...r.fb, candidates: cands } } : r));
      }
      render();
    } catch (e) { console.error(e); patchRec(ply, (r) => ({ ...r, aiErr: errMsg(e) })); render(); }
  })();
  if (term) { await explain; finish(endText(chess)); }
}

async function startGame() {
  const g = ++gid; over = false; chess = new Chess(); preP = null; retryFn = null;
  Object.assign(S, { recs: [], fens: [START], view: 0, result: "", report: null, chat: [], tab: "coach", setup: false, hint: null, sel: null, promo: null, thinking: false, analyzing: 0, error: "", busy: "" });
  S.clock = [S.minutes * 60000, S.minutes * 60000]; render();
  await Promise.all([play.ready, ana.ready]); if (g !== gid) return;
  const first = analyze(START); first.catch(() => { });
  if (S.color === "w") {
    preP = first; render();
    first.then((a) => { if (g === gid && chess.history().length === 0) { S.hint = a; render(); } }).catch(() => { });
  } else await doAI(g, first, {});
}

async function onUserMove(from, to, promotion) {
  const g = gid;
  if (S.thinking || over || chess.turn() !== S.color || !preP) return;
  let m; try { m = chess.move({ from, to, promotion }); } catch (e) { return; }
  const ply = chess.history().length, sans = chess.history(), term = terminalEv(chess), prevP = preP;
  S.sel = null; S.promo = null; S.hint = null; S.error = "";
  pushRec({ ply, side: "user", san: m.san, uci: m.from + m.to + (m.promotion || ""), from: m.from, to: m.to, ev: term || { cp: 0, mate: null } }, m.after);
  const postP = term ? Promise.resolve(null) : analyze(m.after); postP.catch(() => { });
  // 코치 피드백: AI의 수 계산을 막지 않도록 별도로 진행
  const fbP = (async () => {
    try {
      const [prev, post] = await track(Promise.all([prevP, postP]));
      if (g !== gid) return null;
      const ev = term || lineEv(post.lines[0], turnOf(m.after));
      const fb = evaluateUserMove({ prev, post, postEv: ev, move: m, ply, sans });
      patchRec(ply, (r) => ({ ...r, ev, fb })); render(); return fb;
    } catch (e) { console.error(e); patchRec(ply, (r) => ({ ...r, fbErr: errMsg(e) })); render(); return null; }
  })();
  if (term) { await fbP; finish(endText(chess)); return; }
  await doAI(g, postP, { userMove: m, fbP });
}

/* ───── 보드 ───── */
const boardEl = $("board");
const pos = (sq) => { const f = FILES.indexOf(sq[0]), r = +sq[1] - 1, fl = S.color === "b"; return { x: fl ? 7 - f : f, y: fl ? r : 7 - r }; };
function sqFromEvent(cx, cy) {
  const r = boardEl.getBoundingClientRect(), x = Math.floor(((cx - r.left) / r.width) * 8), y = Math.floor(((cy - r.top) / r.height) * 8);
  if (x < 0 || x > 7 || y < 0 || y > 7) return null;
  const fl = S.color === "b";
  return FILES[fl ? 7 - x : x] + ((fl ? y : 7 - y) + 1);
}
function renderBoard() {
  const c = new Chess(S.fens[S.view]), turn = c.turn(), last = S.view > 0 ? S.recs[S.view - 1] : null, fl = S.color === "b";
  const legal = S.sel ? c.moves({ square: S.sel, verbose: true }).map((m) => m.to) : [];
  let checkSq = null;
  if (c.inCheck()) for (const row of c.board()) for (const p of row) if (p && p.type === "k" && p.color === turn) checkSq = p.square;
  let h = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const f = fl ? 7 - x : x, r = fl ? y : 7 - y, sq = FILES[f] + (r + 1), light = (f + r) % 2 === 1;
    let inner = "";
    if (last && (last.from === sq || last.to === sq)) inner += `<i style="background:rgba(201,164,92,.45)"></i>`;
    if (S.sel === sq) inner += `<i style="background:rgba(201,164,92,.6)"></i>`;
    if (checkSq === sq) inner += `<i style="background:radial-gradient(circle,rgba(224,82,77,.95) 0%,rgba(224,82,77,.15) 70%)"></i>`;
    if (legal.includes(sq)) inner += c.get(sq) ? `<i style="inset:4%;border-radius:50%;border:4px solid rgba(20,22,27,.35)"></i>` : `<i style="inset:35%;border-radius:50%;background:rgba(20,22,27,.3)"></i>`;
    const col = light ? "#4f6384" : "#b9c0cc";
    if (x === 0) inner += `<em class="co" style="left:2px;top:0;color:${col}">${r + 1}</em>`;
    if (y === 7) inner += `<em class="co" style="right:2px;bottom:0;color:${col}">${FILES[f]}</em>`;
    h += `<div class="sq ${light ? "l" : "d"}" style="left:${x * 12.5}%;top:${y * 12.5}%">${inner}</div>`;
  }
  for (const row of c.board()) for (const p of row) {
    if (!p) continue;
    const { x, y } = pos(p.square), isLast = last && last.to === p.square;
    let st = `left:${x * 12.5}%;top:${y * 12.5}%;`;
    if (S.drag && S.drag.moved && S.drag.from === p.square) st += "opacity:.25;";
    if (isLast) { const a = pos(last.from); st += `--dx:${(a.x - x) * 100}%;--dy:${(a.y - y) * 100}%;`; }
    h += `<div class="pc ${isLast ? "slide" : ""}" style="${st}"><span class="p${p.color}">${GLYPH[p.type]}\uFE0E</span></div>`;
  }
  if (S.arrows && isLive() && S.hint && userTurn()) {
    const cs = toCands(S.hint), cols = ["#c9a45c", "#7f93b8", "#5a6b8c"];
    let sv = `<svg viewBox="0 0 8 8"><defs>`;
    cs.forEach((cd, i) => { sv += `<marker id="ah${i}" markerWidth="4" markerHeight="4" refX="2.2" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 z" fill="${cols[i]}"/></marker>`; });
    sv += `</defs>`;
    cs.forEach((cd, i) => {
      const a = pos(cd.uci.slice(0, 2)), b = pos(cd.uci.slice(2, 4)), x1 = a.x + .5, y1 = a.y + .5, x2 = b.x + .5, y2 = b.y + .5, dx = x2 - x1, dy = y2 - y1, l = Math.hypot(dx, dy) || 1;
      sv += `<line x1="${x1}" y1="${y1}" x2="${x2 - dx / l * .32}" y2="${y2 - dy / l * .32}" stroke="${cols[i]}" stroke-width=".16" stroke-linecap="round" opacity=".85" marker-end="url(#ah${i})"/>`;
    });
    h += sv + `</svg>`;
  }
  if (S.promo) h += `<div class="promo"><div>${["q", "r", "b", "n"].map((t) => `<button data-promo="${t}" aria-label="승급"><span class="p${turn}">${GLYPH[t]}\uFE0E</span></button>`).join("")}</div></div>`;
  boardEl.innerHTML = h;
}
function tryMove(from, to) {
  const ms = chess.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!ms.length) return false;
  if (ms.some((m) => m.promotion)) { S.promo = { from, to }; render(); return true; }
  onUserMove(from, to); return true;
}
let ghost = null;
boardEl.addEventListener("pointerdown", (e) => {
  const pb = e.target.closest("[data-promo]");
  if (pb) { const p = S.promo; S.promo = null; onUserMove(p.from, p.to, pb.dataset.promo); return; }
  if (!userTurn() || S.promo) return;
  const sq = sqFromEvent(e.clientX, e.clientY); if (!sq) return;
  const legal = S.sel ? chess.moves({ square: S.sel, verbose: true }).map((m) => m.to) : [];
  if (S.sel && legal.includes(sq)) { const f = S.sel; S.sel = null; tryMove(f, sq); return; }
  const p = chess.get(sq);
  if (p && p.color === chess.turn()) { S.sel = sq; S.drag = { from: sq, moved: false }; boardEl.setPointerCapture(e.pointerId); }
  else S.sel = null;
  renderBoard();
});
boardEl.addEventListener("pointermove", (e) => {
  if (!S.drag) return;
  if (!S.drag.moved) { S.drag.moved = true; const p = chess.get(S.drag.from); ghost = document.createElement("div"); ghost.id = "ghost"; ghost.className = "p" + p.color; ghost.textContent = GLYPH[p.type] + "\uFE0E"; document.body.appendChild(ghost); renderBoard(); }
  ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px";
});
const endDrag = (e, cancel) => {
  if (!S.drag) return;
  const d = S.drag; S.drag = null; if (ghost) { ghost.remove(); ghost = null; }
  const sq = cancel ? null : sqFromEvent(e.clientX, e.clientY);
  if (d.moved && sq && sq !== d.from) { S.sel = null; if (!tryMove(d.from, sq)) { S.sel = d.from; renderBoard(); } } else renderBoard();
};
boardEl.addEventListener("pointerup", (e) => endDrag(e, false));
boardEl.addEventListener("pointercancel", (e) => endDrag(e, true));

/* ───── 패널 ───── */
function fbCard(r) {
  const f = r.fb;
  return `<div class="card"><div class="hd"><div><span class="t">AI 분석</span> &nbsp;${esc(r.san)} ${badge(f.grade)}</div><span class="muted">깊이 ${f.depth} · ${f.ms}ms</span></div>
  <p style="margin:8px 0 0"><b>${GRADES[f.grade].ko}</b> — ${esc(f.verdict)}</p>
  <p class="muted" style="margin:4px 0 0">평가(백 기준) ${fmtEv(f.evBefore)} → ${fmtEv(f.evAfter)}${f.bestSan ? " · 엔진 최선 " + esc(f.bestSan) : ""}</p>
  ${sec("전략적 목적", f.purpose)}${sec("얻을 수 있는 이점", f.pros)}${sec("간과한 부분", f.missed)}${sec("상대가 활용할 수 있는 약점", f.weaknesses)}
  ${f.candidates.length ? sec("다음에 고려할 후보 수", f.candidates.map((c) => `${c.san} (${fmtEv(c.ev)}) — ${c.pv.join(" ")}`)) : `<p class="muted" style="margin-top:12px">후보 수는 AI의 응수 후 계산됩니다…</p>`}
  ${sec("포지션에 미치는 영향", [f.impact])}
  <div class="note">분석은 Stockfish 깊이 ${f.depth}의 결과이며 더 깊이 계산하면 평가가 달라질 수 있습니다. 등급은 승률 손실(%p) 임계값으로 결정됩니다.</div></div>`;
}
function aiCard(r) {
  const a = r.ai;
  return `<div class="card"><div class="hd"><span class="t">CHESS MIND AI</span><span class="muted">깊이 ${a.depth} · ${a.matchesBest ? "엔진 1순위" : "최선 대비 -" + a.lossPct.toFixed(1) + "%p"}</span></div>
  <p style="margin:8px 0 0">이번 수: <b>${a.pieceKo} ${esc(a.san)}</b> <span class="muted">(수 이후 재분석 ${fmtEv(r.ev)}, 백 기준)</span></p>
  ${sec("선택 이유", a.reason)}${sec("직전 수와의 연결", [a.link])}${sec("전략적 목적", a.purpose)}${sec("상대에게 주는 위협", a.threat)}${a.pvSan.length ? sec("엔진 예상 진행", [a.pvSan.join(" ")]) : ""}</div>`;
}
function coachTab() {
  const sel = S.view > 0 ? S.view - 1 : S.recs.length - 1, cur = S.recs[sel], nxt = S.recs[sel + 1], prv = S.recs[sel - 1];
  const u = cur && cur.side === "user" ? cur : prv && prv.side === "user" ? prv : null;
  const a = cur && cur.side === "ai" ? cur : nxt && nxt.side === "ai" ? nxt : null;
  if (!u && !a) return `<div class="card muted" style="font-size:14px">첫 수를 두면 Stockfish가 수를 분석하고, 등급과 한국어 코칭이 여기에 표시됩니다.</div>`;
  const wait = (who, r, err) => `<div class="card"><span class="t">${who}</span> <span class="muted">${esc(r.san)}</span><p class="muted" style="margin:8px 0 0;font-size:13px">${err ? "분석에 실패했습니다: " + esc(err) : "Stockfish가 분석 중입니다… 곧 표시됩니다."}</p></div>`;
  return (u ? (u.fb ? fbCard(u) : wait("AI 분석", u, u.fbErr)) : "") + (a ? (a.ai ? aiCard(a) : wait("CHESS MIND AI", a, a.aiErr)) : "");
}
function posTab() {
  const fen = S.fens[S.view], r = S.report && S.reportFen === fen ? S.report : null;
  let h = `<button class="gold" data-act="report" ${!S.ready ? "disabled" : ""}>현재 포지션 분석하기</button>`;
  if (r) {
    const hh = (x) => x.map((z) => NAME[z.type] + z.sq).join(" ") || "–";
    h += `<div class="card" style="margin-top:12px"><div class="muted">깊이 ${r.depth} · ${r.ms}ms · 평가는 백 기준</div><table><tr class="h"><td></td><td>백</td><td>흑</td></tr>
    <tr><td>기물 가치</td><td>${r.material.w}</td><td>${r.material.b}</td></tr><tr><td>활동성(이동 수)</td><td>${r.mob.w}</td><td>${r.mob.b}</td></tr>
    <tr><td>중앙 통제</td><td>${r.center.w}</td><td>${r.center.b}</td></tr><tr><td>킹 안전</td><td>${r.king.w.label}</td><td>${r.king.b.label}</td></tr>
    <tr><td>취약 기물</td><td>${hh(r.hang.w)}</td><td>${hh(r.hang.b)}</td></tr></table>
    ${sec("AI가 보는 주요 전략", r.strategy)}${sec("엔진 후보 수", r.cands.map((c) => `${c.san} (${fmtEv(c.ev)}) — ${c.pv.join(" ")}`))}</div>`;
  }
  h += `<div class="card" style="margin-top:12px"><div class="muted">현재 포지션에 대해 질문하세요. 답변은 Stockfish 분석값에서 계산한 지표로만 구성됩니다.</div>
  <div class="chips">${["최선의 수", "누가 유리해?", "킹 안전", "중앙 통제", "위협", "전략", "기물 활동성"].map((t) => `<button data-ask="${t}" ${!S.ready ? "disabled" : ""}>${t}</button>`).join("")}</div>
  <div class="ask"><input id="q" placeholder="예: 내 킹은 안전해?" autocomplete="off"><button data-act="askinput">질문</button></div>
  <div>${S.chat.map((c) => `<div class="qa"><div class="q">Q. ${esc(c.q)}</div>${esc(c.a)}</div>`).join("")}</div></div>`;
  return h;
}
function reviewTab() {
  const ur = S.recs.filter((r) => r.fb);
  if (!ur.length) return `<div class="card muted" style="font-size:14px">분석된 수가 아직 없습니다.</div>`;
  const rank = ["Brilliant", "Great", "Best", "Excellent", "Good"];
  const best = ur.filter((r) => rank.includes(r.fb.grade)).sort((a, b) => rank.indexOf(a.fb.grade) - rank.indexOf(b.fb.grade) || a.fb.lossPct - b.fb.lossPct).slice(0, 3);
  const worst = ur.filter((r) => r.fb.lossPct > 5).sort((a, b) => b.fb.lossPct - a.fb.lossPct).slice(0, 3);
  const dist = {}; ur.forEach((r) => { dist[r.fb.grade] = (dist[r.fb.grade] || 0) + 1; });
  const evs = [0, ...S.recs.map((r) => Math.max(-500, Math.min(500, r.ev.cp)))], n = Math.max(1, evs.length - 1);
  const X = (i) => (i / n) * 300, Y = (e) => 45 - (e / 500) * 42;
  const top = (title, rows, empty) => `<div class="card top"><div class="t">${title}</div>${rows.length ? `<ul style="padding:0;margin:8px 0 0">${rows.map((r) => `<li><button data-ply="${r.ply}"><span>${Math.ceil(r.ply / 2)}수 · ${esc(r.san)}</span><span>${badge(r.fb.grade)} <span class="muted">-${r.fb.lossPct.toFixed(1)}%p</span></span></button></li>`).join("")}</ul>` : `<p class="muted" style="margin:8px 0 0;font-size:14px">${empty}</p>`}</div>`;
  return (S.result ? `<div class="card" style="box-shadow:0 0 0 1px rgba(201,164,92,.3)"><b style="color:var(--gold)">${esc(S.result)}</b></div>` : "") +
    `<div class="card"><div class="t">평가 그래프 <span class="muted">(백 기준, ±5.00 클램프 · 점을 눌러 이동)</span></div>
    <svg viewBox="0 0 300 90" style="width:100%;margin-top:8px"><rect width="300" height="90" fill="#0b1220"/><line x1="0" y1="45" x2="300" y2="45" stroke="#2b3a58"/>
    <polyline fill="none" stroke="#c9a45c" stroke-width="1.6" points="${evs.map((e, i) => X(i) + "," + Y(e)).join(" ")}"/>
    ${evs.map((e, i) => `<circle data-ply="${i}" cx="${X(i)}" cy="${Y(e)}" r="${i === S.view ? 3.5 : 2}" fill="${i === S.view ? "#fff" : "#c9a45c"}" style="cursor:pointer"/>`).join("")}</svg></div>
    <div class="card"><div class="t">내 수 등급 분포</div><div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;font-size:12px">${Object.keys(dist).map((g) => `<span>${badge(g)} ×${dist[g]}</span>`).join("")}</div></div>` +
    top("가장 잘한 수 TOP 3", best, "해당하는 수가 없습니다.") + top("가장 아쉬운 수 TOP 3", worst, "승률 5%p 이상 손실한 수가 없습니다.");
}
function renderMoves() {
  const rows = []; S.recs.forEach((r, i) => { if (i % 2 === 0) rows.push([r]); else rows[rows.length - 1].push(r); });
  if (!rows.length) { $("moves").innerHTML = `<span class="muted">아직 수가 없습니다.</span>`; return; }
  $("moves").innerHTML = rows.map((p, i) => {
    const cells = S.color === "b" && i === 0 ? [null, ...p] : p;
    return `<div class="mrow"><span class="n">${i + 1}.</span>${cells.map((r) => r ? `<button class="mv ${S.view === r.ply ? "on" : ""}" data-ply="${r.ply}"><span>${esc(r.san)}</span>${r.fb ? `<span style="color:${GRADES[r.fb.grade].color};font-size:12px">${GRADES[r.fb.grade].sym}</span>` : ""}</button>` : `<span class="mv muted">…</span>`).join("")}</div>`;
  }).join("");
}
function playerBar(el, side) {
  const t = turnOf(S.fens[S.view]) === side && !S.result, user = side === S.color;
  el.className = "player" + (t ? " turn" : "");
  el.innerHTML = `<div><span class="dot"></span><b style="font-weight:500;font-size:14px">${user ? "당신" : "CHESS MIND AI · " + lvlInfo().ko}</b><small>${side === "w" ? "백" : "흑"}</small></div><span class="clock" data-clock="${side}">${S.minutes ? fmtClock(S.clock[side === "w" ? 0 : 1]) : "∞"}</span>`;
}
function render() {
  const lastRec = S.view > 0 ? S.recs[S.view - 1] : null, ev = lastRec ? lastRec.ev : { cp: 0, mate: null };
  playerBar($("top"), S.color === "w" ? "b" : "w"); playerBar($("bottom"), S.color);
  renderBoard();
  $("info").innerHTML = `<span>${S.result ? `<b>${esc(S.result)}</b>` : esc(S.thinking ? "AI가 수를 계산하는 중…" : S.error ? S.error : S.analyzing ? "코치 분석 중… (수를 계속 둘 수 있습니다)" : userTurn() ? "당신의 차례입니다" : isLive() ? "" : "지난 포지션 보기 중")}${S.error ? ` <button data-act="retry" style="height:24px;padding:0 8px;margin-left:6px">다시 시도</button>` : ""}</span><span>${fmtEv(ev)} (${describeEv(ev)}, 백 기준)</span>`;
  $("btn-arrows").classList.toggle("on", S.arrows); $("btn-resign").disabled = !!S.result || S.setup;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.act === "tab:" + S.tab));
  const keep = document.activeElement && document.activeElement.id === "q" ? $("q").value : null;
  $("panel").innerHTML = S.tab === "coach" ? coachTab() : S.tab === "pos" ? posTab() : reviewTab();
  if (keep !== null && $("q")) { $("q").value = keep; $("q").focus(); }
  renderMoves();
  $("setup").classList.toggle("hide", !S.setup);
}

async function ask(text) {
  if (!text.trim() || !S.ready) return;
  const fen = S.fens[S.view];
  let r = S.report && S.reportFen === fen ? S.report : null;
  if (!r) { try { r = positionReport(await track(analyze(fen))); S.report = r; S.reportFen = fen; } catch (err) { S.chat.push({ q: text, a: "분석 실패: " + errMsg(err) }); render(); return; } }
  S.chat.push({ q: text, a: answerQuestion(text, r) }); render();
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act],[data-ply],[data-ask]"); if (!t) return;
  if (t.dataset.ply !== undefined) { S.view = +t.dataset.ply; S.sel = null; render(); return; }
  if (t.dataset.ask) return ask(t.dataset.ask);
  const a = t.dataset.act, n = S.fens.length - 1;
  if (a === "first") S.view = 0; else if (a === "prev") S.view = Math.max(0, S.view - 1); else if (a === "next") S.view = Math.min(n, S.view + 1); else if (a === "last") S.view = n;
  else if (a === "arrows") S.arrows = !S.arrows;
  else if (a === "retry") { if (retryFn) retryFn(); return; }
  else if (a === "restart") { over = true; gid++; S.busy = ""; S.thinking = false; S.error = ""; S.setup = true; }
  else if (a === "resign") { if (S.recs.length) return finish("게임 종료 (기권)"); over = true; S.setup = true; }
  else if (a.startsWith("tab:")) S.tab = a.slice(4);
  else if (a === "report") { const fen = S.fens[S.view]; try { S.report = positionReport(await track(analyze(fen))); S.reportFen = fen; } catch (err) { S.chat.push({ q: "포지션 분석", a: "분석 실패: " + errMsg(err) }); } }
  else if (a === "askinput") return ask($("q").value);
  S.sel = null; render();
});
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "q") ask(e.target.value); });

/* 설정 화면 */
function renderSetup() {
  $("o-color").innerHTML = ["w", "b"].map((c) => `<button data-c="${c}" class="${S.color === c ? "on" : ""}">${c === "w" ? "백" : "흑"}</button>`).join("");
  $("o-lvl").innerHTML = LEVELS.map((l, i) => `<button data-l="${i}" class="${S.lvl === i ? "on" : ""}">${l.ko}</button>`).join("");
  const L = lvlInfo(); $("l-lvl").textContent = `AI 난이도 — Skill ${L.skill} · 탐색 깊이 ≤${L.depth} · ${L.ms}ms`;
}
$("s-min").innerHTML = [0, 3, 5, 10, 15, 30].map((m) => `<option value="${m}" ${m === 10 ? "selected" : ""}>${m ? m + "분" : "무제한"}</option>`).join("");
$("s-depth").innerHTML = [10, 12, 14, 16, 18].map((m) => `<option value="${m}" ${m === 14 ? "selected" : ""}>깊이 ${m}</option>`).join("");
$("s-min").onchange = (e) => (S.minutes = +e.target.value); $("s-depth").onchange = (e) => (S.adepth = +e.target.value);
$("setup").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.c) S.color = b.dataset.c; if (b.dataset.l) S.lvl = +b.dataset.l; renderSetup(); });
$("go").onclick = startGame;
renderSetup(); render();

setInterval(() => {
  if (S.setup || over || !S.minutes || !S.recs.length && S.color === "w" && !preP) return;
  const t = chess.turn() === "w" ? 0 : 1;
  S.clock[t] = Math.max(0, S.clock[t] - 200);
  document.querySelectorAll("[data-clock]").forEach((el) => { el.textContent = fmtClock(S.clock[el.dataset.clock === "w" ? 0 : 1]); });
  if (S.clock[t] === 0) finish(`시간 초과 — ${t === 0 ? "흑" : "백"} 승리`);
}, 200);

try {
  play = new Engine(); ana = new Engine();
  Promise.all([play.ready, ana.ready]).then(() => { S.ready = true; $("status").textContent = "Stockfish 16 준비됨"; $("go").disabled = false; $("go").textContent = "대국 시작"; render(); });
} catch (e) { $("status").textContent = "Stockfish Worker를 시작하지 못했습니다: " + e; $("status").className = "err"; }
