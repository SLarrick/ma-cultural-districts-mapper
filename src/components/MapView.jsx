import { useEffect, useRef, useCallback, useState } from 'react'
import { MapContainer, TileLayer, GeoJSON, CircleMarker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet-draw'
import 'leaflet-draw/dist/leaflet.draw.css'
import '@geoman-io/leaflet-geoman-free'
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css'
import * as turf from '@turf/turf'

const TILE_LAYERS = {
  streets: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri',
  },
  simple: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; CartoDB',
  },
}

const MA_CENTER = [42.36, -71.06]
const MA_ZOOM = 8
const LARGE_CITY_THRESHOLD = 20000
const LARGE_CITY_DEFAULT_ZOOM = 15
const LARGE_CITY_MIN_ZOOM = 14
const ARCGIS_BASE = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/Massachusetts_Property_Tax_Parcels/FeatureServer/0/query'
const MACRIS_BASE = 'https://services1.arcgis.com/hGdibHYSPO59RG1h/arcgis/rest/services/MHC_Inventory_GDB/FeatureServer'

// Convert "BEVERLY" → "Beverly", "EAST LONGMEADOW" → "East Longmeadow"
function toTitleCase(str) {
  return str.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
}

function getParcelId(feature) {
  return feature.properties?.LOC_ID || feature.properties?.PROP_ID || feature.id
}

// ── Map controller: handles zoom transitions ──
function MapController({ municipality, parcelsData, isLargeCity, estimatedCount }) {
  const map = useMap()
  const prevKeyRef = useRef(null)

  // Fly to municipality — re-run when isLargeCity resolves (estimatedCount becomes non-null)
  useEffect(() => {
    if (!municipality) {
      map.setView(MA_CENTER, MA_ZOOM)
      prevKeyRef.current = null
      return
    }
    // Wait until the count query finishes before flying
    if (estimatedCount === null) return

    const key = `${municipality.name}-${isLargeCity}`
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key
      const zoom = isLargeCity ? LARGE_CITY_DEFAULT_ZOOM : 15
      map.flyTo([municipality.lat, municipality.lng], zoom, { duration: 0.8 })
    }
  }, [municipality, map, isLargeCity, estimatedCount])

  // Once parcels finish loading (small cities), fit to their bounds
  useEffect(() => {
    if (!municipality || !parcelsData || isLargeCity) return
    try {
      const layer = L.geoJSON(parcelsData)
      const bounds = layer.getBounds()
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [20, 20], animate: true, duration: 0.5 })
      }
    } catch { /* keep current view */ }
  }, [parcelsData, map, municipality, isLargeCity])

  return null
}

// ── Style updater: repaints parcels when selection or visibility changes ──
function ParcelStyleUpdater({ geoJsonRef, selectedParcels, layerVisibility }) {
  useEffect(() => {
    if (!geoJsonRef.current) return
    const showBorders = layerVisibility.parcelBoundaries
    const showSelected = layerVisibility.selectedLots
    geoJsonRef.current.eachLayer((layer) => {
      const id = getParcelId(layer.feature)
      const isSelected = selectedParcels.has(id)
      if (isSelected && showSelected) {
        layer.setStyle({
          color: '#e94560',
          weight: 2.5,
          fillColor: '#e94560',
          fillOpacity: 0.3,
          opacity: 1,
        })
        if (layer.bringToFront) layer.bringToFront()
      } else {
        layer.setStyle({
          color: showBorders ? '#3388ff' : 'transparent',
          weight: showBorders ? 0.8 : 0,
          fillColor: 'transparent',
          fillOpacity: 0,
          opacity: showBorders ? 1 : 0,
        })
      }
    })
  }, [selectedParcels, geoJsonRef, layerVisibility])
  return null
}

// ── Lasso tool: draw to select OR deselect ──
function LassoTool({ geoJsonRef, setSelectedParcels, lassoMode, setLassoMode, setStatusMessage }) {
  const map = useMap()
  const drawControlRef = useRef(null)
  const drawnItemsRef = useRef(null)

  useEffect(() => {
    const drawnItems = new L.FeatureGroup()
    map.addLayer(drawnItems)
    drawnItemsRef.current = drawnItems

    map.on(L.Draw.Event.CREATED, (e) => {
      const drawnLayer = e.layer
      drawnItems.addLayer(drawnLayer)

      if (geoJsonRef.current) {
        const drawnGeoJSON = drawnLayer.toGeoJSON()
        let count = 0
        const isDeselect = drawnLayer._lassoMode === 'deselect'

        setSelectedParcels(prev => {
          const next = new Set(prev)
          geoJsonRef.current.eachLayer((parcelLayer) => {
            const id = getParcelId(parcelLayer.feature)
            if (!id) return
            try {
              const parcelGeoJSON = parcelLayer.toGeoJSON()
              if (turf.booleanIntersects(drawnGeoJSON, parcelGeoJSON)) {
                if (isDeselect) {
                  next.delete(id)
                } else {
                  next.add(id)
                }
                count++
              }
            } catch { /* skip */ }
          })
          return next
        })
        setStatusMessage(`${isDeselect ? 'Deselected' : 'Selected'} ${count} parcels`)
      }

      setTimeout(() => drawnItems.clearLayers(), 400)
      setLassoMode(null)
    })

    map.on(L.Draw.Event.DRAWSTOP, () => setLassoMode(null))

    return () => {
      map.removeLayer(drawnItems)
      map.off(L.Draw.Event.CREATED)
      map.off(L.Draw.Event.DRAWSTOP)
    }
  }, [map, geoJsonRef, setSelectedParcels, setLassoMode, setStatusMessage])

  useEffect(() => {
    if (lassoMode) {
      const color = lassoMode === 'deselect' ? '#888' : '#22c55e'
      const handler = new L.Draw.Polygon(map, {
        shapeOptions: { color, weight: 2, fillOpacity: 0.1, dashArray: lassoMode === 'deselect' ? '6,4' : '' },
        showArea: false, showLength: false,
      })
      // Tag mode on the handler so CREATED event knows
      const origAddHooks = handler.addHooks.bind(handler)
      handler.addHooks = function () {
        origAddHooks()
      }
      drawControlRef.current = handler
      handler.enable()
      // Store mode for the created event
      const origFire = map.fire.bind(map)
      map.fire = function (type, data) {
        if (type === L.Draw.Event.CREATED && data?.layer) {
          data.layer._lassoMode = lassoMode
        }
        return origFire(type, data)
      }
    } else if (drawControlRef.current) {
      drawControlRef.current.disable()
      drawControlRef.current = null
      // Restore original fire
      delete map.fire
    }
  }, [lassoMode, map])

  return null
}

// ── Editable boundary layer with geoman ──
function EditableBoundary({ boundaryLayer, setBoundaryLayer, editingBoundary }) {
  const map = useMap()
  const layerRef = useRef(null)
  const boundaryRef = useRef(boundaryLayer)

  // Keep ref in sync so the effect can read the latest value without depending on it
  useEffect(() => {
    boundaryRef.current = boundaryLayer
  }, [boundaryLayer])

  useEffect(() => {
    // Helper: read the current edited geometry from the Leaflet layer
    function captureGeometry() {
      if (!layerRef.current) return null
      const gj = layerRef.current.toGeoJSON()
      if (!gj.features || gj.features.length === 0) return null
      if (gj.features.length === 1) return gj.features[0]
      let merged = gj.features[0]
      for (let i = 1; i < gj.features.length; i++) {
        try { merged = turf.union(turf.featureCollection([merged, gj.features[i]])) } catch { /* keep */ }
      }
      return merged
    }

    // Helper: tear down the editable layer
    function teardown(saveGeometry) {
      if (!layerRef.current) return
      if (saveGeometry) {
        const geo = captureGeometry()
        if (geo) setBoundaryLayer(geo)
      }
      layerRef.current.eachLayer((sub) => {
        sub.off('pm:edit')
        sub.off('pm:markerdragend')
        if (sub.pm) sub.pm.disable()
      })
      map.removeLayer(layerRef.current)
      layerRef.current = null
    }

    if (!editingBoundary || !boundaryRef.current) {
      // Exiting edit mode — capture final geometry before removing
      teardown(true)
      return
    }

    // Entering edit mode — create editable layer from current boundary
    const layer = L.geoJSON(boundaryRef.current, {
      style: {
        color: '#7c3aed',
        weight: 3,
        fillColor: '#8b5cf6',
        fillOpacity: 0.18,
        dashArray: '8, 4',
      },
    })
    layer.addTo(map)
    layerRef.current = layer

    // Enable geoman edit on each sublayer and listen for edits ON THE LAYER
    layer.eachLayer((subLayer) => {
      subLayer.pm.enable({ allowSelfIntersection: true })
    })

    return () => {
      // Cleanup on unmount — capture geometry
      teardown(true)
    }
  }, [editingBoundary, map, setBoundaryLayer])

  return null
}

// ── Viewport-based parcel loader for large cities ──
function ViewportParcelLoader({ municipality, isLargeCity, setParcelsData, setStatusMessage, setLoading, parcelsCache }) {
  const map = useMap()
  const loadingRef = useRef(false)
  const [belowMinZoom, setBelowMinZoom] = useState(false)

  useEffect(() => {
    if (!municipality || !isLargeCity) {
      setBelowMinZoom(false)
      return
    }

    async function loadForViewport() {
      const zoom = map.getZoom()
      if (zoom < LARGE_CITY_MIN_ZOOM) {
        setBelowMinZoom(true)
        setParcelsData(null)
        return
      }
      setBelowMinZoom(false)
      if (loadingRef.current) return
      loadingRef.current = true
      setLoading(true)

      const bounds = map.getBounds()
      const sw = bounds.getSouthWest()
      const ne = bounds.getNorthEast()
      const envelope = `${sw.lng},${sw.lat},${ne.lng},${ne.lat}`
      const cacheKey = `${municipality.townId}-${envelope}`

      if (parcelsCache.current[cacheKey]) {
        setParcelsData(parcelsCache.current[cacheKey])
        setStatusMessage(`${parcelsCache.current[cacheKey].features.length} parcels in view`)
        setLoading(false)
        loadingRef.current = false
        return
      }

      setStatusMessage('Loading parcels for current view...')
      try {
        let allFeatures = []
        let offset = 0
        let hasMore = true
        while (hasMore) {
          const url = `${ARCGIS_BASE}?where=TOWN_ID=${municipality.townId}&geometry=${envelope}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=LOC_ID,PROP_ID,SITE_ADDR,OWNER1&f=geojson&outSR=4326&returnGeometry=true&resultOffset=${offset}&resultRecordCount=2000`
          const resp = await fetch(url)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          if (data.features && data.features.length > 0) {
            data.features.forEach((f, i) => {
              if (!f.id) f.id = f.properties?.LOC_ID || f.properties?.PROP_ID || `vp-${offset + i}`
            })
            allFeatures = allFeatures.concat(data.features)
            offset += 2000
            if (data.features.length < 2000) hasMore = false
          } else {
            hasMore = false
          }
        }
        if (allFeatures.length > 0) {
          const fc = { type: 'FeatureCollection', features: allFeatures }
          parcelsCache.current[cacheKey] = fc
          setParcelsData(fc)
          setStatusMessage(`${allFeatures.length} parcels in view`)
        } else {
          setParcelsData(null)
          setStatusMessage('No parcels in current view')
        }
      } catch (err) {
        setStatusMessage(`Error loading parcels: ${err.message}`)
      }
      setLoading(false)
      loadingRef.current = false
    }

    // Debounced load on move/zoom
    let timer = null
    const handleMoveEnd = () => {
      clearTimeout(timer)
      timer = setTimeout(loadForViewport, 400)
    }

    // Initial load
    loadForViewport()
    map.on('moveend', handleMoveEnd)
    map.on('zoomend', handleMoveEnd)

    return () => {
      clearTimeout(timer)
      map.off('moveend', handleMoveEnd)
      map.off('zoomend', handleMoveEnd)
    }
  }, [municipality, isLargeCity, map, setParcelsData, setStatusMessage, setLoading, parcelsCache])

  if (belowMinZoom) {
    return (
      <div style={{
        position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        zIndex: 1000, background: 'rgba(26,26,46,0.85)', color: 'white',
        padding: '14px 24px', borderRadius: 8, textAlign: 'center', pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 14 }}>Zoom in to see parcels</div>
      </div>
    )
  }
  return null
}

// ── MACRIS reference layers (lazy-loaded when toggled on) ──
function MacrisLayers({ municipality, layerVisibility, setStatusMessage }) {
  const [districts, setDistricts] = useState(null) // GeoJSON FeatureCollection
  const [resources, setResources] = useState(null) // GeoJSON FeatureCollection
  const loadedTownRef = useRef({ districts: null, resources: null })
  const loadingRef = useRef({ districts: false, resources: false })

  // Reset when municipality changes
  useEffect(() => {
    setDistricts(null)
    setResources(null)
    loadedTownRef.current = { districts: null, resources: null }
  }, [municipality])

  // Load historic districts (Layer 1) when toggled on
  useEffect(() => {
    if (!municipality || !layerVisibility.historicDistricts) return
    if (districts && loadedTownRef.current.districts === municipality.name) return
    if (loadingRef.current.districts) return

    const townName = toTitleCase(municipality.name)
    loadingRef.current.districts = true
    let cancelled = false

    async function load() {
      setStatusMessage(`Loading MACRIS historic districts for ${townName}...`)
      try {
        let allFeatures = []
        let offset = 0
        let hasMore = true
        while (hasMore) {
          const url = `${MACRIS_BASE}/1/query?where=TOWN_NAME='${encodeURIComponent(townName)}'&outFields=MHCN,HISTORIC_N,TYPE,DESIGNATIO,LEGEND,USE_TYPE&f=geojson&outSR=4326&returnGeometry=true&resultOffset=${offset}&resultRecordCount=2000`
          const resp = await fetch(url)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          if (data.features && data.features.length > 0) {
            allFeatures = allFeatures.concat(data.features)
            offset += 2000
            if (data.features.length < 2000) hasMore = false
          } else {
            hasMore = false
          }
        }
        if (!cancelled) {
          setDistricts({ type: 'FeatureCollection', features: allFeatures })
          loadedTownRef.current.districts = municipality.name
          setStatusMessage(`Loaded ${allFeatures.length} MACRIS historic district${allFeatures.length !== 1 ? 's' : ''}`)
        }
      } catch (err) {
        if (!cancelled) setStatusMessage(`Error loading MACRIS districts: ${err.message}`)
      }
      loadingRef.current.districts = false
    }
    load()
    return () => { cancelled = true }
  }, [municipality, layerVisibility.historicDistricts, districts, setStatusMessage])

  // Load historic resources (Layer 0) when toggled on
  useEffect(() => {
    if (!municipality || !layerVisibility.historicResources) return
    if (resources && loadedTownRef.current.resources === municipality.name) return
    if (loadingRef.current.resources) return

    const townName = toTitleCase(municipality.name)
    loadingRef.current.resources = true
    let cancelled = false

    async function load() {
      setStatusMessage(`Loading MACRIS historic resources for ${townName}...`)
      try {
        let allFeatures = []
        let offset = 0
        let hasMore = true
        while (hasMore) {
          const url = `${MACRIS_BASE}/0/query?where=TOWN_NAME='${encodeURIComponent(townName)}'&outFields=MHCN,HISTORIC_N,COMMON_NAM,ADDRESS,TYPE,DESIGNATIO,LEGEND,CONSTRUCTI&f=geojson&outSR=4326&returnGeometry=true&resultOffset=${offset}&resultRecordCount=2000`
          const resp = await fetch(url)
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          const data = await resp.json()
          if (data.features && data.features.length > 0) {
            allFeatures = allFeatures.concat(data.features)
            offset += 2000
            if (data.features.length < 2000) hasMore = false
          } else {
            hasMore = false
          }
        }
        if (!cancelled) {
          setResources({ type: 'FeatureCollection', features: allFeatures })
          loadedTownRef.current.resources = municipality.name
          setStatusMessage(`Loaded ${allFeatures.length.toLocaleString()} MACRIS historic resources`)
        }
      } catch (err) {
        if (!cancelled) setStatusMessage(`Error loading MACRIS resources: ${err.message}`)
      }
      loadingRef.current.resources = false
    }
    load()
    return () => { cancelled = true }
  }, [municipality, layerVisibility.historicResources, resources, setStatusMessage])

  const districtStyle = useCallback(() => ({
    color: '#059669',
    weight: 2.5,
    fillColor: '#059669',
    fillOpacity: 0.22,
  }), [])

  // Label each district with its name (permanent tooltip centered on polygon)
  const onEachDistrict = useCallback((feature, layer) => {
    const p = feature.properties || {}
    const name = p.HISTORIC_N || p.MHCN || ''
    if (name) {
      layer.bindTooltip(name, {
        permanent: true,
        direction: 'center',
        className: 'macris-district-label',
      })
    }
  }, [])

  return (
    <>
      {/* Historic district polygons — non-interactive so clicks pass through to parcels */}
      {layerVisibility.historicDistricts && districts && districts.features.length > 0 && (
        <GeoJSON
          key={`macris-districts-${municipality?.name}-${districts.features.length}`}
          data={districts}
          style={districtStyle}
          onEachFeature={onEachDistrict}
          interactive={false}
        />
      )}

      {/* Historic resource points — non-interactive so clicks pass through to parcels */}
      {layerVisibility.historicResources && resources && resources.features.map((feature, i) => {
        const coords = feature.geometry?.coordinates
        if (!coords || coords.length < 2) return null
        const p = feature.properties || {}
        const isNRHP = (p.LEGEND || '').includes('NRHP')
        return (
          <CircleMarker
            key={`macris-pt-${i}`}
            center={[coords[1], coords[0]]}
            radius={3}
            interactive={false}
            pathOptions={{
              color: isNRHP ? '#7c2d12' : '#9a7b4f',
              fillColor: isNRHP ? '#dc2626' : '#d4a574',
              fillOpacity: 0.7,
              weight: 1,
              interactive: false,
            }}
          />
        )
      })}
    </>
  )
}

// ── Main component ──
export default function MapView({
  municipality,
  selectedParcels,
  onParcelClick,
  parcelsData,
  setParcelsData,
  culturalAssets,
  boundaryLayer,
  setBoundaryLayer,
  editingBoundary,
  baseLayer,
  setLoading,
  setStatusMessage,
  setSelectedParcels,
  setHoveredParcel,
  layerVisibility,
}) {
  const geoJsonRef = useRef()
  const parcelsCache = useRef({})
  const tile = TILE_LAYERS[baseLayer] || TILE_LAYERS.streets
  const [lassoMode, setLassoMode] = useState(null) // null | 'select' | 'deselect'
  const [isLargeCity, setIsLargeCity] = useState(false)
  const [estimatedCount, setEstimatedCount] = useState(null)

  // Determine if municipality is large
  useEffect(() => {
    if (!municipality) {
      setIsLargeCity(false)
      setEstimatedCount(null)
      return
    }
    // Quick count query
    async function checkSize() {
      try {
        const url = `${ARCGIS_BASE}?where=TOWN_ID=${municipality.townId}&returnCountOnly=true&f=json`
        const resp = await fetch(url)
        const data = await resp.json()
        const count = data.count || 0
        setEstimatedCount(count)
        setIsLargeCity(count > LARGE_CITY_THRESHOLD)
      } catch {
        setIsLargeCity(false)
      }
    }
    checkSize()
  }, [municipality])

  // Full-load for small/medium cities
  useEffect(() => {
    if (!municipality || isLargeCity || estimatedCount === null) {
      if (!municipality) setParcelsData(null)
      return
    }
    if (isLargeCity) return // viewport loader handles this

    setParcelsData(null)
    let cancelled = false
    async function loadParcels() {
      setLoading(true)
      setStatusMessage(`Loading ${estimatedCount?.toLocaleString()} parcels for ${municipality.name}...`)
      try {
        await loadParcelsInBatches(municipality, (data) => {
          if (!cancelled) setParcelsData(data)
        }, (msg) => {
          if (!cancelled) setStatusMessage(msg)
        })
      } catch (err) {
        if (!cancelled) {
          setStatusMessage(`Error loading parcels: ${err.message}`)
          setParcelsData(null)
        }
      }
      if (!cancelled) setLoading(false)
    }
    loadParcels()
    return () => { cancelled = true }
  }, [municipality, isLargeCity, estimatedCount, setParcelsData, setLoading, setStatusMessage])

  // Clear parcels when switching municipality for large cities
  useEffect(() => {
    if (isLargeCity) {
      setParcelsData(null)
      parcelsCache.current = {}
    }
  }, [municipality, isLargeCity, setParcelsData])

  const onParcelClickRef = useRef(onParcelClick)
  onParcelClickRef.current = onParcelClick

  const setHoveredRef = useRef(setHoveredParcel)
  setHoveredRef.current = setHoveredParcel

  const onEachParcel = useCallback((feature, layer) => {
    const id = getParcelId(feature)
    const addr = feature.properties?.SITE_ADDR || ''
    const owner = feature.properties?.OWNER1 || ''

    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e)
      if (id) onParcelClickRef.current(id)
    })

    layer.on('mouseover', () => {
      setHoveredRef.current({ addr, owner })
    })
    layer.on('mouseout', () => {
      setHoveredRef.current(null)
    })
  }, [])

  const defaultStyle = useCallback(() => ({
    color: '#3388ff',
    weight: 0.8,
    fillColor: 'transparent',
    fillOpacity: 0,
  }), [])

  const geoJsonKey = parcelsData ? `parcels-${municipality?.name}-${parcelsData.features.length}` : 'no-parcels'

  return (
    <MapContainer center={MA_CENTER} zoom={MA_ZOOM} style={{ height: '100%', width: '100%' }}>
      <TileLayer url={tile.url} attribution={tile.attribution} />
      <MapController municipality={municipality} parcelsData={parcelsData} isLargeCity={isLargeCity} estimatedCount={estimatedCount} />
      <ParcelStyleUpdater geoJsonRef={geoJsonRef} selectedParcels={selectedParcels} layerVisibility={layerVisibility} />
      <LassoTool
        geoJsonRef={geoJsonRef}
        setSelectedParcels={setSelectedParcels}
        lassoMode={lassoMode}
        setLassoMode={setLassoMode}
        setStatusMessage={setStatusMessage}
      />

      {isLargeCity && (
        <ViewportParcelLoader
          municipality={municipality}
          isLargeCity={isLargeCity}
          setParcelsData={setParcelsData}
          setStatusMessage={setStatusMessage}
          setLoading={setLoading}
          parcelsCache={parcelsCache}
        />
      )}

      {parcelsData && (layerVisibility.parcelBoundaries || layerVisibility.selectedLots) && (
        <GeoJSON
          key={geoJsonKey}
          ref={geoJsonRef}
          data={parcelsData}
          style={defaultStyle}
          onEachFeature={onEachParcel}
        />
      )}

      {/* Static boundary display (when not editing) */}
      {boundaryLayer && !editingBoundary && layerVisibility.boundary && (
        <GeoJSON
          key={`boundary-static-${Date.now()}`}
          data={boundaryLayer}
          style={{
            color: '#7c3aed',
            weight: 3,
            fillColor: '#8b5cf6',
            fillOpacity: 0.18,
            dashArray: '8, 4',
          }}
        />
      )}

      {/* Editable boundary (when editing) */}
      <EditableBoundary
        boundaryLayer={boundaryLayer}
        setBoundaryLayer={setBoundaryLayer}
        editingBoundary={editingBoundary}
      />

      {/* Cultural asset dots — small gold markers */}
      {layerVisibility.assets && culturalAssets.filter(a => a.lat != null && a.lng != null).map((asset, i) => (
        <CircleMarker
          key={asset.id || i}
          center={[asset.lat, asset.lng]}
          radius={4}
          pathOptions={{
            color: asset.status === 'out_of_muni' ? '#b91c1c' : '#92400e',
            fillColor: asset.status === 'out_of_muni' ? '#ef4444' : '#f59e0b',
            fillOpacity: 0.9,
            weight: 1.5,
          }}
        >
          <Popup>
            <strong>{asset.name}</strong>
            <br />
            {asset.address}
            {asset.type && <><br /><em>{asset.type}</em></>}
            {asset.status === 'out_of_muni' && <><br /><span style={{ color: '#b91c1c' }}>⚠ Outside selected municipality</span></>}
          </Popup>
        </CircleMarker>
      ))}

      {/* MACRIS reference layers */}
      <MacrisLayers
        municipality={municipality}
        layerVisibility={layerVisibility}
        setStatusMessage={setStatusMessage}
      />

      {/* Loading overlay */}
      <LoadingOverlay municipality={municipality} parcelsData={parcelsData} isLargeCity={isLargeCity} />

      {/* Lasso buttons */}
      {parcelsData && (
        <LassoButtons lassoMode={lassoMode} setLassoMode={setLassoMode} />
      )}
    </MapContainer>
  )
}

// ── Loading overlay ──
function LoadingOverlay({ municipality, parcelsData, isLargeCity }) {
  if (!municipality || parcelsData || isLargeCity) return null
  return (
    <div style={{
      position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      zIndex: 1000, background: 'rgba(26, 26, 46, 0.9)', color: 'white',
      padding: '20px 32px', borderRadius: 10, textAlign: 'center', pointerEvents: 'none',
    }}>
      <div style={{
        width: 32, height: 32, margin: '0 auto 12px',
        border: '3px solid rgba(255,255,255,0.2)', borderTopColor: '#e94560',
        borderRadius: '50%', animation: 'spin 0.7s linear infinite',
      }} />
      <div style={{ fontSize: 15, fontWeight: 500 }}>Loading {municipality.name} parcels...</div>
      <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>This may take a moment for larger towns</div>
    </div>
  )
}

// ── Lasso buttons: Select + Deselect ──
function LassoButtons({ lassoMode, setLassoMode }) {
  const btnStyle = (mode, activeColor) => ({
    position: 'relative',
    width: 34, height: 34,
    background: lassoMode === mode ? activeColor : 'white',
    color: lassoMode === mode ? 'white' : '#333',
    border: '2px solid rgba(0,0,0,0.2)',
    borderRadius: 4,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', fontSize: 14, fontWeight: 'bold',
    boxShadow: '0 1px 5px rgba(0,0,0,0.2)',
  })

  return (
    <div style={{
      position: 'absolute', top: 80, left: 10, zIndex: 1000,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div
        onClick={() => setLassoMode(lassoMode === 'select' ? null : 'select')}
        title="Draw shape to select parcels"
        style={btnStyle('select', '#22c55e')}
      >
        +⬡
      </div>
      <div
        onClick={() => setLassoMode(lassoMode === 'deselect' ? null : 'deselect')}
        title="Draw shape to deselect parcels"
        style={btnStyle('deselect', '#ef4444')}
      >
        −⬡
      </div>
    </div>
  )
}

// ── Full batch loader (for small/medium cities) ──
async function loadParcelsInBatches(municipality, setParcelsData, setStatusMessage) {
  const townId = municipality.townId
  const batchSize = 2000
  let offset = 0
  let allFeatures = []
  let hasMore = true

  while (hasMore) {
    const url = `${ARCGIS_BASE}?where=TOWN_ID=${townId}&outFields=LOC_ID,PROP_ID,SITE_ADDR,OWNER1&f=geojson&outSR=4326&returnGeometry=true&resultOffset=${offset}&resultRecordCount=${batchSize}`
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()

    if (data.features && data.features.length > 0) {
      data.features.forEach((f, i) => {
        if (!f.id) f.id = f.properties?.LOC_ID || f.properties?.PROP_ID || `parcel-${offset + i}`
      })
      allFeatures = allFeatures.concat(data.features)
      setStatusMessage(`Loading parcels... ${allFeatures.length.toLocaleString()} loaded`)
      offset += batchSize
      if (data.features.length < batchSize) hasMore = false
    } else {
      hasMore = false
    }
  }

  if (allFeatures.length > 0) {
    setParcelsData({ type: 'FeatureCollection', features: allFeatures })
    setStatusMessage(`Loaded ${allFeatures.length.toLocaleString()} parcels for ${municipality.name}`)
  } else {
    setStatusMessage('No parcels found for this municipality')
  }
}
