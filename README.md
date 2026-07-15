# MA Cultural Districts Mapper

A geospatial web tool for defining, editing, and exporting cultural district boundaries in Massachusetts. Built for non-technical staff at non-profit arts districts applying for designation from the Massachusetts Cultural Council.

Users can:

- Select a Massachusetts municipality and zoom to its parcel map
- Click parcels to include them in a proposed district
- Upload a spreadsheet of cultural asset addresses and auto-select parcels those addresses fall on
- Generate a (multi)polygon boundary from the selected parcels, edit its vertices, and export as SHP, KML, or GeoJSON
- Toggle base layers (simple parcel map, roads, satellite) and reference layers (MHC historic districts / resources)

## Tech stack

- **Vite + React 19**
- **Leaflet** with `react-leaflet`, `leaflet-draw`, and `@geoman-io/leaflet-geoman-free` for map interaction
- **Turf.js** for geometry ops
- `@mapbox/shp-write`, `papaparse`, `xlsx` for import/export

## Development

Requires Node 24 (see `.nvmrc`).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build to dist/
npm run preview  # serve the production build
npm run lint
```

## Project layout

```
src/               React app source
public/            Static assets served at web root
reference/         Product brief, source spreadsheet, and MHC shapefile (not deployed)
```

## Data sources

- MA municipality list — bundled in `src/data/municipalities.js`
- MHC Inventory (historic districts and resources) — `reference/MHC_Inventory_SHP.zip`, from the [Massachusetts Historical Commission](https://www.sec.state.ma.us/mhc/)
- Parcel data — MassGIS Level 3 Assessors' Parcels (loaded on demand)

## License

TBD.
