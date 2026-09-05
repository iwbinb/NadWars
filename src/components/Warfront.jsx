import { memo } from "react";
import {
  ArrowsOutIcon,
  ArrowLeftIcon,
  LightningIcon,
  UsersIcon,
  ArrowRightIcon,
} from "@phosphor-icons/react";
import { Battlefield } from "./Battlefield.jsx";
import { ZONES, maskCount, effectiveZone } from "../game/rules.js";

export const Warfront = memo(function Warfront({
  zones,
  players = [],
  now = 0,
  zone = 0,
  onZone,
  overview,
  onOverview,
  selected,
  onSelect,
  team = 0,
  interactive = true,
  viewer,
}) {
  const present = (z) =>
    players.filter(
      (p) => p && effectiveZone(p, now) === z && p.arriveAt <= now,
    );
  const pick = (z, tile) => {
    onZone?.(z);
    onSelect?.(tile);
    onOverview?.(false);
  };
  const heading = (z) => (
    <>
      <span className="zone-letter">{["N", "E", "W", "S"][z.index]}</span>
      <strong>{ZONES[z.index]}</strong>
      <span className="zone-rates">
        <b className="purple">
          {maskCount(z.power1)}
          <LightningIcon weight="fill" />
        </b>
        <b className="amber">
          {maskCount(z.power2)}
          <LightningIcon weight="fill" />
        </b>
      </span>
      <span className="zone-population">
        <UsersIcon />
        {present(z.index).length}
      </span>
    </>
  );
  if (zones.length === 1)
    return (
      <Battlefield
        board={zones[0].board}
        selected={selected}
        onSelect={onSelect}
        team={team}
        interactive={interactive}
      />
    );
  return (
    <div className={`warfront ${overview ? "overview" : "focused"}`}>
      <div className="warfront-bar">
        <button className="text-button" onClick={() => onOverview(!overview)}>
          {overview ? <ArrowsOutIcon /> : <ArrowLeftIcon />}
          {overview ? "四战区总览" : "返回全局"}
        </button>
        <span>
          {overview ? "点击战区查看并指挥" : `${ZONES[zone]} · 49 格能源战场`}
        </span>
        {viewer && (
          <button
            className="text-button"
            onClick={() => {
              onZone(effectiveZone(viewer, now));
              onOverview(false);
            }}
          >
            我的战区
            <ArrowRightIcon />
          </button>
        )}
      </div>
      {overview ? (
        <div className="zone-grid">
          {zones.map((z) => (
            <section
              key={z.index}
              className={`zone-sector ${viewer && effectiveZone(viewer, now) === z.index ? "current" : ""}`}
            >
              <button
                className="zone-heading"
                onClick={() => {
                  onZone(z.index);
                  onOverview(false);
                }}
                aria-label={`查看${ZONES[z.index]}`}
              >
                {heading(z)}
                <ArrowsOutIcon />
              </button>
              <Battlefield
                board={z.board}
                compact
                interactive={interactive}
                selected={zone === z.index ? selected : null}
                team={team}
                onSelect={(tile) => pick(z.index, tile)}
              />
              <div className="zone-caption">
                <span className="purple">{Math.floor(z.scores?.[0] || 0)}</span>
                <span>区域积分</span>
                <span className="amber">{Math.floor(z.scores?.[1] || 0)}</span>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <>
          <div className="zone-tabs" aria-label="切换战区">
            {zones.map((z) => (
              <button
                key={z.index}
                className={zone === z.index ? "active" : ""}
                onClick={() => onZone(z.index)}
                aria-pressed={zone === z.index}
              >
                {heading(z)}
              </button>
            ))}
          </div>
          <Battlefield
            board={zones[zone].board}
            selected={selected}
            onSelect={onSelect}
            team={team}
            interactive={interactive}
          />
        </>
      )}
    </div>
  );
});
