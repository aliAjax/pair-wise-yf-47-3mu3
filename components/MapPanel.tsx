"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Section, ShuttlePlan, Station } from "../lib/ledger/types";

const emptyStyle = {
  version: 8 as const,
  sources: {},
  layers: [{ id: "background", type: "background" as const, paint: { "background-color": "#dce9f5" } }]
};

export function MapPanel({ stations, sections, plans }: { stations: Station[]; sections: Section[]; plans: ShuttlePlan[] }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    let disposed = false;
    void import("maplibre-gl").then(({ Map, Marker }) => {
      if (!container.current || disposed) return;
      const map = new Map({ container: container.current, style: emptyStyle, center: [121.47, 31.23], zoom: 11.2 });
      mapRef.current = map;
      stations.forEach((station, index) => {
        const element = document.createElement("button");
        element.className = `station-marker ${station.status}`;
        element.textContent = station.name.slice(0, 2);
        element.title = `${station.name}：${station.status}`;
        new Marker({ element }).setLngLat([121.38 + index * 0.075, 31.18 + index * 0.035]).addTo(map);
      });
      sections.forEach((section, index) => {
        const element = document.createElement("div");
        element.className = section.status === "放行" ? "section-marker open" : "section-marker blocked";
        element.textContent = section.status === "放行" ? "PASS" : "HOLD";
        element.title = `${section.name}：${section.status}`;
        new Marker({ element }).setLngLat([121.40 + index * 0.08, 31.24 - index * 0.02]).addTo(map);
      });
      plans.forEach((plan, index) => {
        const element = document.createElement("div");
        element.className = "shuttle-marker";
        element.textContent = `BUS${plan.vehicles}`;
        new Marker({ element }).setLngLat([121.42 + index * 0.08, 31.27 - index * 0.025]).addTo(map);
      });
    });
    return () => { disposed = true; mapRef.current?.remove(); mapRef.current = null; };
  }, [stations, sections, plans]);

  return <div className="map-wrap"><div ref={container} className="map" /><div className="map-legend"><span><i className="dot danger" />封闭/限流</span><span><i className="dot normal" />正常</span><span><i className="bus" />接驳车</span></div></div>;
}
