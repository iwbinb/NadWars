import { useEffect, useRef, useState } from "react";
import { KIND, KIND_ASSET, TEAM, tileLabel, neighbors } from "../game/rules.js";

const VIOLET = "#9670ff",
  AMBER = "#ffb45b";
const ASSETS = {
  terrain: "/assets/terrain-hex.png",
  reactor: "/assets/reactor-violet.png",
  relay: "/assets/relay-violet.png",
  objective: "/assets/objective-violet.png",
  turret: "/assets/turret-violet.png",
  shield: "/assets/shield-violet.png",
};
const promises = new Map();
function loadAsset(src) {
  if (!promises.has(src))
    promises.set(
      src,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`素材加载失败：${src}`));
        img.src = src;
      }),
    );
  return promises.get(src);
}
// Flat-top axial hex coordinates, projected onto the miniature board.
function layout(width, height, compact = false) {
  const perspective = compact ? 0.58 : 1;
  const scale = Math.min(
    (width - 28) / 560,
    (height - 18) / (compact ? 302 : 475),
  );
  const s = Math.max(0.14, scale),
    x0 = width / 2 - 225 * s,
    y0 = (height - (compact ? 275 : 440) * s) / 2 + (compact ? 40 : 18) * s;
  return {
    s,
    perspective,
    center: (i) => ({
      x: x0 + (i % 7) * 75 * s,
      y: y0 + ((i % 7) * 0.5 + Math.floor(i / 7)) * 46 * s * perspective,
    }),
  };
}

export function Battlefield({
  board,
  selected,
  onSelect,
  team = 0,
  interactive = true,
  compact = false,
  focusTile = null,
}) {
  const canvas = useRef(null),
    surface = useRef(null),
    assets = useRef(null);
  const [size, setSize] = useState({ w: 900, h: 650 }),
    [loaded, setLoaded] = useState(false),
    [failure, setFailure] = useState(""),
    [hover, setHover] = useState(null);
  useEffect(() => {
    let alive = true;
    Promise.all(
      Object.entries(ASSETS).map(async ([key, src]) => [
        key,
        await loadAsset(src),
      ]),
    )
      .then((entries) => {
        if (alive) {
          assets.current = Object.fromEntries(entries);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setFailure(e.message);
      });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    if (surface.current) ro.observe(surface.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!loaded || !canvas.current) return;
    const c = canvas.current,
      dpr = Math.min(window.devicePixelRatio || 1, 2),
      ctx = c.getContext("2d");
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, size.h);
    const { s, center, perspective } = layout(size.w, size.h, compact);
    const images = assets.current;
    const ordered = [...board].sort(
      (a, b) => center(a.index).y - center(b.index).y,
    );
    // Each real raster terrain tile is placed independently; hit targets map to the same coordinates.
    for (const tile of ordered) {
      const { x, y } = center(tile.index);
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(
        images.terrain,
        x - 53 * s,
        y - 49 * s * perspective,
        106 * s,
        106 * s * perspective,
      );
      if (tile.team) {
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle =
          tile.team === 1 ? "rgba(134,93,255,.07)" : "rgba(255,177,72,.06)";
      }
      ctx.restore();
    }
    // These lines visualize current contract connectivity, not decorative art assets.
    for (const tile of board)
      if (tile.team && tile.kind) {
        for (const n of neighbors(tile.index)) {
          const next = board[n];
          if (n <= tile.index || next.team !== tile.team || !next.kind)
            continue;
          const a = center(tile.index),
            b = center(n),
            active = tile.powered && next.powered;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.lineWidth = 5 * s;
          ctx.strokeStyle = "#111522";
          ctx.stroke();
          ctx.lineWidth = 2.1 * s;
          ctx.strokeStyle = active
            ? tile.team === 1
              ? VIOLET
              : AMBER
            : "#515565";
          ctx.shadowColor = active ? ctx.strokeStyle : "transparent";
          ctx.shadowBlur = active ? 7 : 0;
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }
    for (const tile of ordered) {
      const { x, y } = center(tile.index),
        chosen = selected === tile.index || focusTile === tile.index,
        over = hover === tile.index;
      if (chosen || over) {
        ctx.save();
        ctx.strokeStyle = chosen ? (team === 2 ? AMBER : "#baa3ff") : "#8992ab";
        ctx.fillStyle = chosen
          ? "rgba(142,103,255,.18)"
          : "rgba(220,225,255,.06)";
        ctx.lineWidth = (chosen ? 2 : 1) * s;
        ctx.beginPath();
        const verts = [
          [50, 0],
          [25, 23],
          [-25, 23],
          [-50, 0],
          [-25, -23],
          [25, -23],
        ];
        verts.forEach(([dx, dy], j) =>
          j
            ? ctx.lineTo(x + dx * s, y + dy * s * perspective)
            : ctx.moveTo(x + dx * s, y + dy * s * perspective),
        );
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      const assetKey =
        KIND_ASSET[tile.kind] || (tile.objective ? "objective" : null);
      if (assetKey) {
        const img = images[assetKey];
        const isRoot = tile.kind === 1;
        const width =
          (isRoot
            ? 108
            : tile.objective
              ? 90
              : tile.kind === 4
                ? 83
                : tile.kind === 5
                  ? 92
                  : 77) * s;
        const height = (width * img.height) / img.width;
        ctx.save();
        if (tile.team === 2) ctx.filter = "hue-rotate(125deg) saturate(1.2)";
        if (!tile.team || (!tile.powered && !isRoot))
          ctx.filter = "grayscale(1) brightness(.56)";
        ctx.drawImage(img, x - width / 2, y - height * 0.88, width, height);
        ctx.restore();
        if (tile.kind > 1 && tile.hp < tile.maxHp) {
          ctx.fillStyle = "#252331";
          ctx.fillRect(x - 19 * s, y + 4 * s, 38 * s, 3 * s);
          ctx.fillStyle = tile.team === 1 ? VIOLET : AMBER;
          ctx.fillRect(
            x - 19 * s,
            y + 4 * s,
            (38 * s * tile.hp) / tile.maxHp,
            3 * s,
          );
        }
        if (tile.kind && tile.kind !== 1 && !tile.powered) {
          ctx.fillStyle = "#c9bdac";
          ctx.font = `500 ${Math.max(9, 10 * s)}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText("离线", x, y + 18 * s);
        }
      }
      if (chosen) {
        ctx.textAlign = "center";
        ctx.font = `600 ${12 * s}px Inter, sans-serif`;
        ctx.fillStyle = "#fff";
        ctx.fillText(tileLabel(tile.index), x, y + 32 * s);
      }
    }
  }, [board, size, selected, loaded, hover, team, focusTile, compact]);
  const { s, center, perspective } = layout(size.w, size.h, compact);
  return (
    <div ref={surface} className={`battlefield ${compact ? "compact" : ""}`}>
      <canvas ref={canvas} aria-label="七乘七能源战场" />
      {!loaded && !failure && (
        <div className="map-loading">正在准备战场素材…</div>
      )}
      {failure && <div className="map-loading error">{failure}</div>}
      {interactive &&
        board.map((tile) => {
          const { x, y } = center(tile.index);
          return (
            <button
              key={tile.index}
              className="tile-hit"
              data-tile={tile.index}
              data-kind={tile.kind}
              data-team={tile.team}
              data-powered={tile.powered}
              style={{
                left: x,
                top: y,
                width: 65 * s,
                height: 38 * s * perspective,
              }}
              aria-label={`格子 ${tileLabel(tile.index)} ${KIND[tile.kind]} ${TEAM[tile.team]}${tile.kind ? (tile.powered ? " 通电" : " 离线") : ""}`}
              onClick={() => onSelect?.(tile.index)}
              onMouseEnter={() => setHover(tile.index)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(tile.index)}
              onBlur={() => setHover(null)}
            />
          );
        })}
    </div>
  );
}
