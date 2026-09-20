(async function () {
  const auth_state = await (
    window.GEOGUESSER_AUTH_READY ||
    Promise.resolve({ required: false, authenticated: false })
  );

  // Do not load map/image assets until a required login has completed.
  if (auth_state.required && !auth_state.authenticated) return;

  // Frontend reads large assets through the R2 guard Worker in production.
  // To test only local files, set this to "" or set window.GEOGUESSER_ASSET_BASE_URL before app.js loads.
  const DEFAULT_ASSET_BASE_URL = "https://vietnam-geoguesser-r2-guard.my-slave.workers.dev";
  const asset_base_url = normalizeAssetBaseUrl(window.GEOGUESSER_ASSET_BASE_URL || DEFAULT_ASSET_BASE_URL);
  const local_only_assets = new Set(["images/placeholder.svg"]);
  const round_image_cache = new Map();
  const created_image_object_urls = new Set();
  const STANDARD_MATCH_ROUND_COUNT = 8;
  const IMAGE_PRELOAD_CONCURRENCY = 3;
  const DECODE_AHEAD_COUNT = 2;
  const rounds = [];
  let round_image_request_id = 0;
  let round_image_generation = 0;
  let map_initialized = false;
  let map_load_promise = null;
  let preparation_run_id = 0;

  // Map detail tuning. Larger zoom ratios switch to more detailed geometry.
  const MAP_ORIGINAL_DETAIL_ZOOM_RATIO = 6;
  const MAP_LIGHT_DETAIL_ZOOM_RATIO = 3;
  const PROVINCE_LIGHT_SIMPLIFY_TOLERANCE = 0.2;
  const PROVINCE_MODEST_SIMPLIFY_TOLERANCE = 0.55;
  const SPECIAL_LIGHT_SIMPLIFY_TOLERANCE = 0.1;
  const SPECIAL_MODEST_SIMPLIFY_TOLERANCE = 0.25;
  const DENSE_SPECIAL_PROVINCE_CODES = new Set(["22", "31"]);
  const DENSE_SPECIAL_LIGHT_SIMPLIFY_TOLERANCE = 0.38;
  const DENSE_SPECIAL_MODEST_SIMPLIFY_TOLERANCE = 0.9;
  const DENSE_SPECIAL_LIGHT_SNAP_GRID = 0.18;
  const DENSE_SPECIAL_MODEST_SNAP_GRID = 0.42;

  // Single source of truth for the current game session.
  const state = {
    round_index: 0,
    score: 0,
    seconds: 0,
    guess_placed: false,
    guess: null,
    guess_area: null,
    guess_lookup_id: 0,
    revealed: false,
    distance: null,
    round_score: null,
    results_cache: new Map(),
    timer_id: null,
    match_id: null,
    match_started_at: null,
    submitting_guess: false
  };

  // Single source for storing the whole viewing map data
  const map_state = {
    canvas: null,
    ctx: null,
    features: [],
    bounds: null,
    world_width: 1000,
    world_height: 1000,
    width: 0,
    height: 0,
    device_pixel_ratio: 1,
    fit_scale: 1,
    scale: 1,
    offset_x: 0,
    offset_y: 0,
    is_dragging: false,
    is_dragging_guess: false,
    is_dragging_guess_tool: false,
    skip_next_guess_tool_click: false,
    drag_start_x: 0,
    drag_start_y: 0,
    redraw_requested: false,
    selected_feature: null,
    hover_canvas_point: null,
    hovered_feature: null,
    province_properties_by_code: {},
    ward_cache: new Map(),
    ward_loading_code: null,
    ward_loading_promises: new Map(),
    info_collapsed: false,
    resize_observer: null
  };

  // Cache DOM nodes once, then update them from render().
  const elements = {
    round_location: document.getElementById("roundLocation"),
    round_number: document.getElementById("roundNumber"),
    score_value: document.getElementById("scoreValue"),
    timer_value: document.getElementById("timerValue"),
    mode_menu: document.getElementById("modeMenu"),
    game_app: document.getElementById("gameApp"),
    standard_match_button: document.getElementById("standardMatchButton"),
    back_to_menu_button: document.getElementById("backToMenuButton"),
    round_image: document.getElementById("roundImage"),
    image_fallback: document.getElementById("imageFallback"),
    image_title: document.getElementById("imageTitle"),
    image_subtitle: document.getElementById("imageSubtitle"),
    previous_round_button: document.getElementById("previousRoundButton"),
    next_round_button: document.getElementById("nextRoundButton"),
    place_guess_button: document.getElementById("placeGuessButton"),
    clear_guess_button: document.getElementById("clearGuessButton"),
    submit_button: document.getElementById("submitButton"),
    restart_button: document.getElementById("restartButton"),
    guess_status: document.getElementById("guessStatus"),
    distance_value: document.getElementById("distanceValue"),
    round_points: document.getElementById("roundPoints"),
    map_status: document.getElementById("mapStatus"),
    map_info_panel: document.getElementById("mapInfoPanel"),
    map_info_toggle: document.getElementById("mapInfoToggle"),
    map_info_title: document.getElementById("mapInfoTitle"),
    map_info_subtitle: document.getElementById("mapInfoSubtitle"),
    map_info_population: document.getElementById("mapInfoPopulation"),
    map_info_area: document.getElementById("mapInfoArea"),
    map_info_type: document.getElementById("mapInfoType"),
    map_hover_tooltip: document.getElementById("mapHoverTooltip"),
    map_guess_marker: document.getElementById("mapGuessMarker"),
    preparation: document.getElementById("matchPreparation"),
    preparation_status: document.getElementById("preparationStatus"),
    preparation_progress: document.getElementById("preparationProgress"),
    preparation_count: document.getElementById("preparationCount"),
    preparation_retry_button: document.getElementById("preparationRetryButton"),
    preparation_cancel_button: document.getElementById("preparationCancelButton")
  };

  function currentRound() {
    return rounds[state.round_index];
  }

  function normalizeAssetBaseUrl(url) {
    return (url || "").replace(/\/+$/, "");
  }

  function assetUrl(path) {
    if (!path || local_only_assets.has(path)) return path;

    if (/^(https?:)?\/\//.test(path) || path.startsWith("data:") || path.startsWith("blob:")) {
      return path;
    }

    const clean_path = path.replace(/^\.?\//, "");
    return asset_base_url ? `${asset_base_url}/${clean_path}` : clean_path;
  }

  function isProtectedAssetUrl(url) {
    return Boolean(
      asset_base_url &&
      (url === asset_base_url || url.startsWith(`${asset_base_url}/`))
    );
  }

  async function fetchAsset(path, options = {}) {
    const url = assetUrl(path);
    const headers = new Headers(options.headers);

    if (isProtectedAssetUrl(url)) {
      if (typeof window.GEOGUESSER_GET_ACCESS_TOKEN !== "function") {
        throw new Error("Authentication token provider is unavailable.");
      }

      const access_token = await window.GEOGUESSER_GET_ACCESS_TOKEN();
      headers.set("authorization", `Bearer ${access_token}`);
    }

    return fetch(url, {
      ...options,
      headers
    });
  }

  async function fetchJsonAsset(path) {
    const response = await fetchAsset(path);

    if (!response.ok) {
      throw new Error(`Could not load ${path}: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  async function fetchApiJson(path, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    const response = await fetchAsset(path, { ...options, headers });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Request failed: ${response.status} ${response.statusText}`);
    }

    return payload;
  }

  function preferredRoundImageWidth() {
    const frame_width = elements.round_image.parentElement?.getBoundingClientRect().width || window.innerWidth;
    const required_width = frame_width * Math.min(window.devicePixelRatio || 1, 2);
    return required_width <= 1280 ? "1280" : "1920";
  }

  function roundImagePath(round) {
    const separator = round.image_path.includes("?") ? "&" : "?";
    return `${round.image_path}${separator}size=${round.image_width || preferredRoundImageWidth()}`;
  }

  async function fetchRoundImage(round) {
    const path = roundImagePath(round);
    const generation = round_image_generation;
    let entry = round_image_cache.get(path);
    if (entry?.object_url) return entry;
    if (entry?.fetch_promise) return entry.fetch_promise;

    entry = {
      path,
      object_url: null,
      fetch_promise: null,
      decoded_image: null,
      decode_promise: null
    };

    entry.fetch_promise = fetchAsset(path)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Could not load round image: ${response.status} ${response.statusText}`);
        }
        return response.blob();
      })
      .then((blob) => {
        if (generation !== round_image_generation) {
          throw new Error("Round image preload was cancelled.");
        }
        entry.object_url = URL.createObjectURL(blob);
        created_image_object_urls.add(entry.object_url);
        entry.fetch_promise = null;
        return entry;
      })
      .catch((error) => {
        round_image_cache.delete(path);
        throw error;
      });

    round_image_cache.set(path, entry);
    return entry.fetch_promise;
  }

  async function decodeRoundImage(index) {
    const round = rounds[index];
    if (!round) return;

    const entry = await fetchRoundImage(round);
    if (entry.decoded_image) return entry;
    if (entry.decode_promise) return entry.decode_promise;

    entry.decode_promise = (async () => {
      const image = new Image();
      image.src = entry.object_url;
      await image.decode();
      entry.decoded_image = image;
      entry.decode_promise = null;
      return entry;
    })().catch((error) => {
      entry.decode_promise = null;
      throw error;
    });

    return entry.decode_promise;
  }

  async function decodeRoundsAhead(active_index) {
    const first = Math.max(0, active_index);
    const last = Math.min(rounds.length - 1, active_index + DECODE_AHEAD_COUNT);
    await Promise.all(
      Array.from({ length: last - first + 1 }, (_, offset) => decodeRoundImage(first + offset))
    );
    trimDecodedRoundImages(active_index);
  }

  function trimDecodedRoundImages(active_index) {
    rounds.forEach((round, index) => {
      if (index >= active_index - 1 && index <= active_index + DECODE_AHEAD_COUNT) return;

      const entry = round_image_cache.get(roundImagePath(round));
      if (entry?.decoded_image) {
        entry.decoded_image.src = "";
        entry.decoded_image = null;
      }
    });
  }

  async function preloadRoundImages(on_progress) {
    let next_index = 0;
    let completed = 0;

    async function worker() {
      while (next_index < rounds.length) {
        const index = next_index;
        next_index += 1;
        await fetchRoundImage(rounds[index]);
        completed += 1;
        on_progress(completed, rounds.length);
      }
    }

    const worker_count = Math.min(IMAGE_PRELOAD_CONCURRENCY, rounds.length);
    await Promise.all(Array.from({ length: worker_count }, () => worker()));
  }

  function displayCurrentRoundImage() {
    const round = currentRound();
    const request_id = ++round_image_request_id;
    if (!round) return;

    const entry = round_image_cache.get(roundImagePath(round));
    if (!entry?.object_url) {
      elements.round_image.src = "images/placeholder.svg";
      elements.image_fallback.classList.remove("hidden");
      return;
    }

    decodeRoundImage(state.round_index)
      .then(() => {
        if (request_id === round_image_request_id) elements.round_image.src = entry.object_url;
      })
      .catch((error) => {
        console.error("Round image decode failed:", error);
        if (request_id === round_image_request_id) {
          elements.round_image.src = "images/placeholder.svg";
          elements.image_fallback.classList.remove("hidden");
        }
      });
  }

  function releaseRoundImages() {
    round_image_generation += 1;
    for (const entry of round_image_cache.values()) {
      if (entry.decoded_image) entry.decoded_image.src = "";
      if (entry.object_url) {
        URL.revokeObjectURL(entry.object_url);
        created_image_object_urls.delete(entry.object_url);
      }
    }
    round_image_cache.clear();
  }

  // Converts seconds into the mm:ss text shown in the top bar.
  function formatTime(total_seconds) {
    const minutes = Math.floor(total_seconds / 60).toString().padStart(2, "0");
    const seconds = (total_seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  // Called whenever the player moves to a different round.
  function resetRoundFlags() {
    state.guess_placed = false;
    state.guess = null;
    state.guess_area = null;
    state.guess_lookup_id += 1;
    state.revealed = false;
    state.distance = null;
    state.round_score = null;
  }

  function getGuessStatusText() {
    if (!state.guess) return "Chưa đặt";

    if (state.guess_area) {
      if (state.guess_area.ward_name && state.guess_area.province_name) {
        return `${state.guess_area.province_name} / ${state.guess_area.ward_name}`;
      }

      if (state.guess_area.province_name) {
        return state.guess_area.province_name;
      }

      if (state.guess_area.label) {
        return state.guess_area.label;
      }
    }

    return `Lat ${state.guess.lat.toFixed(4)}, Lng ${state.guess.lng.toFixed(4)}`;
  }

  // Re-draws all text, image, and button states from the current state object.
  function render() {
    const round = currentRound();
    const total_rounds = rounds.length;
    const title = round.title || round.name || `Round ${state.round_index + 1}`;
    const province = round.province || round.region || "Tỉnh không xác định";

    elements.round_number.textContent = `${state.round_index + 1}/${total_rounds}`;
    elements.score_value.textContent = state.score.toLocaleString("en-US");
    elements.timer_value.textContent = formatTime(state.seconds);
    elements.round_location.textContent = state.revealed
      ? `${province} (${round.lat}, ${round.lng})`
      : "Vị trí đang được ẩn";

    elements.image_title.textContent = state.revealed ? title : "";
    elements.image_subtitle.textContent = state.revealed ? province : "";
    displayCurrentRoundImage();
    elements.round_image.alt = title;

    elements.distance_value.textContent = state.revealed && state.distance !== null
      ? `${state.distance.toFixed(1)} km`
      : "-- km";
    elements.round_points.textContent = state.revealed
      ? state.round_score.toString()
      : "--";

    elements.previous_round_button.disabled = state.round_index === 0;
    elements.next_round_button.disabled =
      !state.revealed || state.round_index === total_rounds - 1;
    renderGuessControls();
  }

  function renderGuessControls() {
    elements.guess_status.textContent = getGuessStatusText();
    elements.place_guess_button.disabled = state.revealed;
    elements.clear_guess_button.disabled = !state.guess_placed || state.revealed;
    elements.submit_button.disabled = !state.guess_placed || state.revealed || state.submitting_guess;
    updateGuessMarkerPosition();
  }

  function setupMap() {
    map_state.canvas = document.getElementById("map-canvas");
    if (!map_state.canvas || !map_state.canvas.getContext) {
      elements.map_status.textContent = "Canvas unavailable";
      map_load_promise = Promise.reject(new Error("Canvas is unavailable."));
      return map_load_promise;
    }

    map_state.ctx = map_state.canvas.getContext("2d");
    resizeMapCanvas();
    attachMapEvents();
    attachFlagToolDrag();
    attachMapInfoEvents();

    map_state.resize_observer = new ResizeObserver(() => {
      resizeMapCanvas();
      if (map_state.features.length) {
        fitMapToCanvas();
        updateMapCenterReadout();
        updateGuessMarkerPosition();
        requestMapDraw();
      }
    });
    map_state.resize_observer.observe(map_state.canvas.parentElement);

    map_load_promise = loadMapData();
    return map_load_promise;
  }

  function resizeMapCanvas() {
    const rect = map_state.canvas.getBoundingClientRect();
    const pixel_ratio = window.devicePixelRatio || 1;

    map_state.width = Math.max(1, rect.width);
    map_state.height = Math.max(1, rect.height);
    map_state.device_pixel_ratio = pixel_ratio;
    map_state.canvas.width = Math.round(map_state.width * pixel_ratio);
    map_state.canvas.height = Math.round(map_state.height * pixel_ratio);
  }

  async function loadMapData() {
    try {
      const [province_geojson, special_geojson] = await Promise.all([
        fetchJsonAsset("provinces.geojson"),
        fetchJsonAsset("special.geojson")
      ]);

      prepareMapFeatures(province_geojson, special_geojson);
      fitMapToCanvas();
      updateMapCenterReadout();
      updateMapInfoPanel(null);
      requestMapDraw();
    } catch (error) {
      console.error(error);
      elements.map_status.textContent = "Khởi động máy chủ để tải dữ liệu";
      throw error;
    }
  }

  function prepareMapFeatures(province_geojson, special_geojson) {
    map_state.bounds = getGeoJsonBounds([province_geojson, special_geojson]);

    const lng_span = map_state.bounds.max_lng - map_state.bounds.min_lng;
    const lat_span = map_state.bounds.max_lat - map_state.bounds.min_lat;
    map_state.world_height = map_state.world_width * (lat_span / lng_span);

    const province_color_by_code = assignProvinceColors(province_geojson.features);
    const province_properties_by_code = {};
    for (const feature of province_geojson.features) {
      province_properties_by_code[feature.properties.code] = feature.properties;
    }
    map_state.province_properties_by_code = province_properties_by_code;

    const province_features = province_geojson.features.map((feature) => {
      return prepareFeature(feature, "province", province_color_by_code[feature.properties.code] || 0, null);
    });
    const special_features = special_geojson.features.map((feature) => {
      const parent_color_index = province_color_by_code[feature.properties.province_code] || 0;
      return prepareFeature(feature, "special", parent_color_index, province_properties_by_code[feature.properties.province_code]);
    });

    map_state.features = province_features.concat(special_features);
  }

  function assignProvinceColors(features) {
    const palette_count = getMapPaletteSize();
    const adjacency = features.map(() => new Set());
    const point_owners = new Map();

    features.forEach((feature, feature_index) => {
      walkCoordinates(feature.geometry.coordinates, ([lng, lat]) => {
        const key = `${lng.toFixed(3)},${lat.toFixed(3)}`;
        if (!point_owners.has(key)) {
          point_owners.set(key, new Set());
        }
        point_owners.get(key).add(feature_index);
      });
    });

    for (const owners of point_owners.values()) {
      if (owners.size < 2) continue;

      const indexes = Array.from(owners);
      for (let i = 0; i < indexes.length; i += 1) {
        for (let j = i + 1; j < indexes.length; j += 1) {
          adjacency[indexes[i]].add(indexes[j]);
          adjacency[indexes[j]].add(indexes[i]);
        }
      }
    }

    const order = features
      .map((feature, index) => ({ feature, index, degree: adjacency[index].size }))
      .sort((a, b) => b.degree - a.degree || a.feature.properties.code.localeCompare(b.feature.properties.code));
    const assigned = new Array(features.length).fill(null);

    for (const item of order) {
      const used_colors = new Set(Array.from(adjacency[item.index]).map((neighbor_index) => assigned[neighbor_index]));

      for (let color = 0; color < palette_count; color += 1) {
        if (!used_colors.has(color)) {
          assigned[item.index] = color;
          break;
        }
      }

      if (assigned[item.index] === null) {
        assigned[item.index] = item.index % palette_count;
      }
    }

    const color_by_code = {};
    features.forEach((feature, index) => {
      color_by_code[feature.properties.code] = assigned[index];
    });

    return color_by_code;
  }

  function getGeoJsonBounds(geojson_list) {
    const bounds = {
      min_lng: Infinity,
      min_lat: Infinity,
      max_lng: -Infinity,
      max_lat: -Infinity
    };

    for (const geojson of geojson_list) {
      for (const feature of geojson.features) {
        walkCoordinates(feature.geometry.coordinates, ([lng, lat]) => {
          bounds.min_lng = Math.min(bounds.min_lng, lng);
          bounds.min_lat = Math.min(bounds.min_lat, lat);
          bounds.max_lng = Math.max(bounds.max_lng, lng);
          bounds.max_lat = Math.max(bounds.max_lat, lat);
        });
      }
    }

    return bounds;
  }

  function walkCoordinates(coordinates, visitPoint) {
    if (typeof coordinates[0] === "number") {
      visitPoint(coordinates);
      return;
    }

    for (const item of coordinates) {
      walkCoordinates(item, visitPoint);
    }
  }

  function prepareFeature(feature, kind, color_index, parent_properties) {
    const polygons = feature.geometry.coordinates.map((polygon) => {
      return polygon.map((ring) => prepareRing(ring, kind, feature.properties));
    });

    return {
      kind,
      properties: feature.properties,
      parent_properties,
      color_index,
      polygons
    };
  }

  function prepareRing(ring, kind, properties) {
    const points = ring.map(([lng, lat]) => projectLngLat(lng, lat));
    const open_points = removeClosingPoint(points);
    const dense_special = kind === "special" && DENSE_SPECIAL_PROVINCE_CODES.has(properties.province_code);
    const light_tolerance = getLightSimplifyTolerance(kind, dense_special);
    const modest_tolerance = getModestSimplifyTolerance(kind, dense_special);
    const light_source_points = dense_special
      ? snapRingToGrid(open_points, DENSE_SPECIAL_LIGHT_SNAP_GRID)
      : open_points;
    const modest_source_points = dense_special
      ? snapRingToGrid(open_points, DENSE_SPECIAL_MODEST_SNAP_GRID)
      : open_points;
    const light_points = simplifyRing(light_source_points, light_tolerance);
    const modest_points = simplifyRing(modest_source_points, modest_tolerance);
    const bbox = getPointBounds(open_points);

    return {
      points_by_detail: {
        original: open_points,
        light: light_points,
        modest: modest_points
      },
      area: Math.abs(getPolygonArea(open_points)),
      width: bbox.max_x - bbox.min_x,
      height: bbox.max_y - bbox.min_y
    };
  }

  function getLightSimplifyTolerance(kind, dense_special) {
    if (dense_special) return DENSE_SPECIAL_LIGHT_SIMPLIFY_TOLERANCE;
    return kind === "special" ? SPECIAL_LIGHT_SIMPLIFY_TOLERANCE : PROVINCE_LIGHT_SIMPLIFY_TOLERANCE;
  }

  function getModestSimplifyTolerance(kind, dense_special) {
    if (dense_special) return DENSE_SPECIAL_MODEST_SIMPLIFY_TOLERANCE;
    return kind === "special" ? SPECIAL_MODEST_SIMPLIFY_TOLERANCE : PROVINCE_MODEST_SIMPLIFY_TOLERANCE;
  }

  function snapRingToGrid(points, grid_size) {
    if (points.length <= 3) return points;

    const snapped = [];
    for (const point of points) {
      const next_point = {
        x: Math.round(point.x / grid_size) * grid_size,
        y: Math.round(point.y / grid_size) * grid_size
      };
      const previous_point = snapped[snapped.length - 1];

      if (!previous_point || previous_point.x !== next_point.x || previous_point.y !== next_point.y) {
        snapped.push(next_point);
      }
    }

    return snapped.length >= 3 ? snapped : points;
  }

  function projectLngLat(lng, lat) {
    const x = ((lng - map_state.bounds.min_lng) / (map_state.bounds.max_lng - map_state.bounds.min_lng)) * map_state.world_width;
    const y = ((map_state.bounds.max_lat - lat) / (map_state.bounds.max_lat - map_state.bounds.min_lat)) * map_state.world_height;
    return { x, y };
  }

  function removeClosingPoint(points) {
    if (points.length < 2) return points;

    const first = points[0];
    const last = points[points.length - 1];
    if (first.x === last.x && first.y === last.y) {
      return points.slice(0, -1);
    }

    return points;
  }

  function getPointBounds(points) {
    const bounds = {
      min_x: Infinity,
      min_y: Infinity,
      max_x: -Infinity,
      max_y: -Infinity
    };

    for (const point of points) {
      bounds.min_x = Math.min(bounds.min_x, point.x);
      bounds.min_y = Math.min(bounds.min_y, point.y);
      bounds.max_x = Math.max(bounds.max_x, point.x);
      bounds.max_y = Math.max(bounds.max_y, point.y);
    }

    return bounds;
  }

  function getPolygonArea(points) {
    let area = 0;

    for (let i = 0; i < points.length; i += 1) {
      const current = points[i];
      const next = points[(i + 1) % points.length];
      area += current.x * next.y - next.x * current.y;
    }

    return area / 2;
  }

  function simplifyRing(points, tolerance) {
    if (points.length <= 3) return points;

    const squared_tolerance = tolerance * tolerance;
    const simplified = simplifyDouglasPeucker(points, 0, points.length - 1, squared_tolerance);

    return simplified.length >= 3 ? simplified : points;
  }

  function simplifyDouglasPeucker(points, first_index, last_index, squared_tolerance) {
    let max_squared_distance = 0;
    let split_index = first_index;

    for (let i = first_index + 1; i < last_index; i += 1) {
      const squared_distance = getSquaredSegmentDistance(points[i], points[first_index], points[last_index]);
      if (squared_distance > max_squared_distance) {
        max_squared_distance = squared_distance;
        split_index = i;
      }
    }

    if (max_squared_distance > squared_tolerance) {
      const left = simplifyDouglasPeucker(points, first_index, split_index, squared_tolerance);
      const right = simplifyDouglasPeucker(points, split_index, last_index, squared_tolerance);
      return left.slice(0, -1).concat(right);
    }

    return [points[first_index], points[last_index]];
  }

  function getSquaredSegmentDistance(point, segment_start, segment_end) {
    let x = segment_start.x;
    let y = segment_start.y;
    let dx = segment_end.x - x;
    let dy = segment_end.y - y;

    if (dx !== 0 || dy !== 0) {
      const t = ((point.x - x) * dx + (point.y - y) * dy) / (dx * dx + dy * dy);

      if (t > 1) {
        x = segment_end.x;
        y = segment_end.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = point.x - x;
    dy = point.y - y;
    return dx * dx + dy * dy;
  }

  function fitMapToCanvas() {
    const padding = 16;
    const scale_x = (map_state.width - padding * 2) / map_state.world_width;
    const scale_y = (map_state.height - padding * 2) / map_state.world_height;

    map_state.fit_scale = Math.max(0.01, Math.min(scale_x, scale_y));
    map_state.scale = map_state.fit_scale;
    map_state.offset_x = (map_state.width - map_state.world_width * map_state.scale) / 2;
    map_state.offset_y = (map_state.height - map_state.world_height * map_state.scale) / 2;
  }

  function attachMapEvents() {
    map_state.canvas.addEventListener("pointerdown", (event) => {
      if (state.guess && !state.revealed) {
        const canvas_point = getCanvasPoint(event);
        const guess_cp = getCanvasPointFromWorldPoint(state.guess);
        const dist = Math.hypot(canvas_point.x - guess_cp.x, canvas_point.y - guess_cp.y);
        if (dist <= 24) {
          map_state.is_dragging_guess = true;
          map_state.canvas.setPointerCapture(event.pointerId);
          placeGuessAtCanvasPoint(canvas_point, false);
          updateMapHoverFromEvent(event);
          return;
        }
      }

      map_state.is_dragging = true;
      map_state.drag_start_x = event.clientX;
      map_state.drag_start_y = event.clientY;
      map_state.canvas.setPointerCapture(event.pointerId);
      updateMapHoverFromEvent(event);
    });

    map_state.canvas.addEventListener("pointermove", (event) => {
      if (map_state.is_dragging_guess) {
        placeGuessAtCanvasPoint(getCanvasPoint(event), false);
        updateMapHoverFromEvent(event);
        return;
      }

      if (map_state.is_dragging) {
        const dx = event.clientX - map_state.drag_start_x;
        const dy = event.clientY - map_state.drag_start_y;
        map_state.drag_start_x = event.clientX;
        map_state.drag_start_y = event.clientY;
        map_state.offset_x += dx;
        map_state.offset_y += dy;
        requestMapDraw();
      }

      updateMapHoverFromEvent(event);
    });

    map_state.canvas.addEventListener("pointerup", (event) => {
      if (map_state.is_dragging_guess) {
        map_state.is_dragging_guess = false;
        map_state.canvas.releasePointerCapture(event.pointerId);
        placeGuessAtCanvasPoint(getCanvasPoint(event), true);
        updateMapHoverFromEvent(event);
        return;
      }

      map_state.is_dragging = false;
      map_state.canvas.releasePointerCapture(event.pointerId);
      updateMapHoverFromEvent(event);
    });

    map_state.canvas.addEventListener("pointercancel", () => {
      map_state.is_dragging_guess = false;
      map_state.is_dragging = false;
      clearMapHover();
    });

    map_state.canvas.addEventListener("pointerleave", () => {
      if (!map_state.is_dragging_guess && !map_state.is_dragging) {
        clearMapHover();
      }
    });

    map_state.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      if (!map_state.features.length) return;

      const canvas_point = getCanvasPoint(event);
      const world_x = (canvas_point.x - map_state.offset_x) / map_state.scale;
      const world_y = (canvas_point.y - map_state.offset_y) / map_state.scale;
      const zoom_factor = Math.exp(-event.deltaY * 0.001);
      const min_scale = map_state.fit_scale * 0.75;
      const max_scale = map_state.fit_scale * 96 * 3;
      const next_scale = clamp(map_state.scale * zoom_factor, min_scale, max_scale);

      map_state.scale = next_scale;
      map_state.offset_x = canvas_point.x - world_x * map_state.scale;
      map_state.offset_y = canvas_point.y - world_y * map_state.scale;
      updateMapHoverForCanvasPoint(canvas_point);
      requestMapDraw();
    }, { passive: false });
  }

  function attachFlagToolDrag() {
    if (!elements.place_guess_button) return;

    elements.place_guess_button.addEventListener("pointerdown", (event) => {
      if (state.revealed) return;

      event.preventDefault();
      map_state.is_dragging_guess_tool = true;
      map_state.skip_next_guess_tool_click = false;
      elements.place_guess_button.classList.add("is-dragging");
      elements.place_guess_button.setPointerCapture(event.pointerId);
    });

    elements.place_guess_button.addEventListener("pointermove", (event) => {
      if (!map_state.is_dragging_guess_tool) return;

      event.preventDefault();
      const canvas_point = getCanvasPoint(event);
      if (isCanvasPointInside(canvas_point)) {
        placeGuessAtCanvasPoint(canvas_point, false);
        map_state.skip_next_guess_tool_click = true;
      }
    });

    elements.place_guess_button.addEventListener("pointerup", (event) => {
      if (!map_state.is_dragging_guess_tool) return;

      event.preventDefault();
      const canvas_point = getCanvasPoint(event);
      if (isCanvasPointInside(canvas_point)) {
        placeGuessAtCanvasPoint(canvas_point, true);
        map_state.skip_next_guess_tool_click = true;
      }
      map_state.is_dragging_guess_tool = false;
      elements.place_guess_button.classList.remove("is-dragging");
      elements.place_guess_button.releasePointerCapture(event.pointerId);
    });

    elements.place_guess_button.addEventListener("pointercancel", () => {
      map_state.is_dragging_guess_tool = false;
      elements.place_guess_button.classList.remove("is-dragging");
    });
  }

  function attachMapInfoEvents() {
    elements.map_info_toggle.addEventListener("click", () => {
      map_state.info_collapsed = !map_state.info_collapsed;
      elements.map_info_panel.classList.toggle("is-collapsed", map_state.info_collapsed);
      elements.map_info_toggle.textContent = map_state.info_collapsed ? "<" : ">";
      elements.map_info_toggle.setAttribute("aria-expanded", String(!map_state.info_collapsed));
      elements.map_info_toggle.setAttribute(
        "aria-label",
        map_state.info_collapsed ? "Show map information" : "Hide map information"
      );
    });
  }

  function getCanvasPoint(event) {
    const rect = map_state.canvas.getBoundingClientRect();

    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function isCanvasPointInside(canvas_point) {
    return canvas_point.x >= 0
      && canvas_point.x <= map_state.width
      && canvas_point.y >= 0
      && canvas_point.y <= map_state.height;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getMapCenterLngLat() {
    const world_point = getMapCenterWorldPoint();
    if (!world_point) return null;

    return getLngLatFromWorldPoint(world_point);
  }

  function getLngLatFromWorldPoint(world_point) {
    const lng_span = map_state.bounds.max_lng - map_state.bounds.min_lng;
    const lat_span = map_state.bounds.max_lat - map_state.bounds.min_lat;
    const lng = map_state.bounds.min_lng + (world_point.x / map_state.world_width) * lng_span;
    const lat = map_state.bounds.max_lat - (world_point.y / map_state.world_height) * lat_span;

    return { lng, lat };
  }

  function getMapCenterWorldPoint() {
    if (!map_state.bounds) return null;

    return {
      x: (map_state.width / 2 - map_state.offset_x) / map_state.scale,
      y: (map_state.height / 2 - map_state.offset_y) / map_state.scale
    };
  }

  function getWorldPointFromCanvasPoint(canvas_point) {
    if (!map_state.bounds) return null;

    return {
      x: (canvas_point.x - map_state.offset_x) / map_state.scale,
      y: (canvas_point.y - map_state.offset_y) / map_state.scale
    };
  }

  function getCanvasPointFromWorldPoint(world_point) {
    return {
      x: map_state.offset_x + world_point.x * map_state.scale,
      y: map_state.offset_y + world_point.y * map_state.scale
    };
  }

  function clampWorldPoint(world_point) {
    return {
      x: clamp(world_point.x, 0, map_state.world_width),
      y: clamp(world_point.y, 0, map_state.world_height)
    };
  }

  function placeGuessAtCanvasPoint(canvas_point, should_update_area = true) {
    const world_point = getWorldPointFromCanvasPoint(canvas_point);
    if (!world_point) return;

    setGuessFromWorldPoint(clampWorldPoint(world_point), should_update_area);
  }

  function setGuessFromWorldPoint(world_point, should_update_area = true) {
    const lng_lat = getLngLatFromWorldPoint(world_point);
    const lookup_id = state.guess_lookup_id + 1;

    state.guess = {
      x: world_point.x,
      y: world_point.y,
      lng: lng_lat.lng,
      lat: lng_lat.lat
    };
    state.guess_placed = true;
    state.guess_lookup_id = lookup_id;
    state.guess_area = null;
    updateMapStatusFromLngLat(lng_lat);
    renderGuessControls();
    requestMapDraw();
    if (should_update_area) {
      updateGuessAreaForWorldPoint(world_point, lookup_id);
    }
  }

  function placeGuessAtDefaultPoint() {
    const canvas_point = map_state.hover_canvas_point || {
      x: map_state.width / 2,
      y: map_state.height / 2
    };

    placeGuessAtCanvasPoint(canvas_point);
  }

  function clearGuess() {
    state.guess = null;
    state.guess_placed = false;
    state.guess_area = null;
    state.guess_lookup_id += 1;
    render();
    requestMapDraw();
  }

  function updateGuessMarkerPosition() {
    if (!elements.map_guess_marker) return;

    if (!state.guess) {
      elements.map_guess_marker.classList.remove("is-visible");
      return;
    }

    const canvas_point = getCanvasPointFromWorldPoint(state.guess);
    elements.map_guess_marker.style.left = `${canvas_point.x}px`;
    elements.map_guess_marker.style.top = `${canvas_point.y}px`;
    elements.map_guess_marker.classList.add("is-visible");
  }

  async function updateGuessAreaForWorldPoint(world_point, lookup_id) {
    const feature = findFeatureAtWorldPoint(world_point);
    if (lookup_id !== state.guess_lookup_id || !state.guess) return;

    if (!feature) {
      state.guess_area = { label: "Ngoài biển" };
      render();
      return;
    }

    if (feature.kind === "special") {
      const parent = feature.parent_properties;
      state.guess_area = {
        province_code: feature.properties.province_code,
        province_name: parent ? parent.name || parent.full_name : "",
        ward_name: feature.properties.name || feature.properties.full_name,
        label: feature.properties.name || feature.properties.full_name
      };
      render();
      return;
    }

    const province_code = feature.properties.code;
    state.guess_area = {
      province_code,
      province_name: feature.properties.name || feature.properties.full_name,
      ward_name: null
    };
    render();

    const ward_features = await loadWardFeaturesForProvince(province_code);
    if (lookup_id !== state.guess_lookup_id || !state.guess) return;

    const ward_feature = findFeatureInListAtWorldPoint(world_point, ward_features);
    if (ward_feature) {
      state.guess_area = {
        province_code,
        province_name: feature.properties.name || feature.properties.full_name,
        ward_name: ward_feature.properties.name || ward_feature.properties.full_name
      };
      render();
    }
  }

  async function loadWardFeaturesForProvince(province_code) {
    if (map_state.ward_cache.has(province_code)) {
      return map_state.ward_cache.get(province_code);
    }

    if (map_state.ward_loading_promises.has(province_code)) {
      return map_state.ward_loading_promises.get(province_code);
    }

    map_state.ward_loading_code = province_code;
    const load_promise = (async () => {
      const ward_geojson = await fetchJsonAsset(`wards/${province_code}.geojson`);
      const parent_properties = map_state.province_properties_by_code[province_code] || null;
      const ward_features = ward_geojson.features.map((feature) => {
        return prepareFeature(feature, "ward", 0, parent_properties);
      });

      map_state.ward_cache.set(province_code, ward_features);
      return ward_features;
    })();

    map_state.ward_loading_promises.set(province_code, load_promise);
    try {
      return await load_promise;
    } catch (error) {
      console.error(error);
      return [];
    } finally {
      map_state.ward_loading_promises.delete(province_code);
      if (map_state.ward_loading_code === province_code) {
        map_state.ward_loading_code = null;
      }
    }
  }

  function updateMapCenterReadout() {
    const center = getMapCenterLngLat();
    if (!center) return;

    updateMapStatusFromLngLat(center);
  }

  function updateMapStatusFromLngLat(lng_lat) {
    elements.map_status.textContent = `Lng ${lng_lat.lng.toFixed(5)}, Lat ${lng_lat.lat.toFixed(5)}`;
  }

  function updateMapHoverFromEvent(event) {
    updateMapHoverForCanvasPoint(getCanvasPoint(event));
  }

  function updateMapHoverForCanvasPoint(canvas_point) {
    if (!map_state.features.length) return;

    map_state.hover_canvas_point = canvas_point;

    const world_point = getWorldPointFromCanvasPoint(canvas_point);
    if (!world_point || !map_state.features.length) return;

    const lng_lat = getLngLatFromWorldPoint(world_point);
    updateMapStatusFromLngLat(lng_lat);

    const feature = findFeatureAtWorldPoint(world_point);
    map_state.hovered_feature = feature;
    updateMapInfoPanel(feature);
    updateMapHoverTooltip(canvas_point, feature);
  }

  function clearMapHover() {
    map_state.hover_canvas_point = null;
    map_state.hovered_feature = null;
    hideMapHoverTooltip();
    updateMapCenterReadout();
    updateMapInfoPanel(null);
  }

  function updateMapInfoPanel(feature) {
    if (!feature) {
      elements.map_info_title.textContent = "Ngoài biển";
      elements.map_info_subtitle.textContent = "Di chuột qua một tỉnh";
      elements.map_info_population.textContent = "--";
      elements.map_info_area.textContent = "--";
      elements.map_info_type.textContent = "Biển / ngoài ranh giới";
      return;
    }

    const props = feature.properties;
    const parent = feature.parent_properties;

    if (feature.kind === "special") {
      elements.map_info_title.textContent = props.full_name || props.name;
      elements.map_info_subtitle.textContent = parent
        ? `Thuộc ${parent.full_name || parent.name}`
        : "Khu vực hành chính đặc biệt";
      elements.map_info_population.textContent = parent && parent.population
        ? formatPopulation(parent.population)
        : "--";
      elements.map_info_area.textContent = parent && parent.area_km2
        ? formatArea(parent.area_km2)
        : "--";
      elements.map_info_type.textContent = "Khu vực đảo đặc biệt";
      return;
    }

    elements.map_info_title.textContent = props.full_name || props.name;
    elements.map_info_subtitle.textContent = "Cấp tỉnh";
    elements.map_info_population.textContent = props.population ? formatPopulation(props.population) : "--";
    elements.map_info_area.textContent = props.area_km2 ? formatArea(props.area_km2) : "--";
    elements.map_info_type.textContent = getProvinceType(props);
  }

  function updateMapHoverTooltip(canvas_point, feature) {
    if (!elements.map_hover_tooltip) return;

    if (!feature) {
      hideMapHoverTooltip();
      return;
    }

    elements.map_hover_tooltip.textContent = getFeatureDisplayName(feature);
    elements.map_hover_tooltip.style.left = `${canvas_point.x}px`;
    elements.map_hover_tooltip.style.top = `${canvas_point.y}px`;
    elements.map_hover_tooltip.style.transform = getTooltipTransform(canvas_point);
    elements.map_hover_tooltip.classList.add("is-visible");
    elements.map_hover_tooltip.setAttribute("aria-hidden", "false");
  }

  function hideMapHoverTooltip() {
    if (!elements.map_hover_tooltip) return;

    elements.map_hover_tooltip.classList.remove("is-visible");
    elements.map_hover_tooltip.setAttribute("aria-hidden", "true");
  }

  function getFeatureDisplayName(feature) {
    const props = feature.properties;

    return props.full_name || props.name || "";
  }

  function getTooltipTransform(canvas_point) {
    const x_offset = canvas_point.x > map_state.width - 180 ? "calc(-100% - 12px)" : "12px";
    const y_offset = canvas_point.y > map_state.height - 70 ? "calc(-100% - 12px)" : "12px";

    return `translate(${x_offset}, ${y_offset})`;
  }

  function findFeatureAtWorldPoint(point) {
    for (let i = map_state.features.length - 1; i >= 0; i -= 1) {
      const feature = map_state.features[i];
      if (isPointInFeature(point, feature)) {
        return feature;
      }
    }

    return null;
  }

  function findFeatureInListAtWorldPoint(point, features) {
    for (let i = features.length - 1; i >= 0; i -= 1) {
      const feature = features[i];
      if (isPointInFeature(point, feature)) {
        return feature;
      }
    }

    return null;
  }

  function isPointInFeature(point, feature) {
    for (const polygon of feature.polygons) {
      let inside_polygon = false;

      for (const ring of polygon) {
        if (isPointInRing(point, ring.points_by_detail.original)) {
          inside_polygon = !inside_polygon;
        }
      }

      if (inside_polygon) return true;
    }

    return false;
  }

  function isPointInRing(point, ring_points) {
    let inside = false;

    for (let i = 0, j = ring_points.length - 1; i < ring_points.length; j = i, i += 1) {
      const current = ring_points[i];
      const previous = ring_points[j];
      const crosses_y = (current.y > point.y) !== (previous.y > point.y);
      const x_at_y = ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;

      if (crosses_y && point.x < x_at_y) {
        inside = !inside;
      }
    }

    return inside;
  }

  function formatPopulation(value) {
    return Number(value).toLocaleString("en-US");
  }

  function formatArea(value) {
    return `${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })} km2`;
  }

  function getProvinceType(properties) {
    if (properties.administrative_unit_id === 1) return "Thành phố trực thuộc trung ương";
    if (properties.administrative_unit_id === 2) return "Tỉnh";
    return "Cấp tỉnh";
  }

  function requestMapDraw() {
    if (map_state.redraw_requested) return;

    map_state.redraw_requested = true;
    window.requestAnimationFrame(() => {
      map_state.redraw_requested = false;
      drawMap();
      updateGuessMarkerPosition();
      if (map_state.hover_canvas_point) {
        updateMapHoverForCanvasPoint(map_state.hover_canvas_point);
      } else {
        updateMapCenterReadout();
      }
    });
  }

  function drawMap() {
    if (!map_state.ctx || !map_state.features.length) return;

    const ctx = map_state.ctx;
    const dpr = map_state.device_pixel_ratio;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, map_state.width, map_state.height);
    ctx.fillStyle = "#eef6f7";
    ctx.fillRect(0, 0, map_state.width, map_state.height);

    ctx.save();
    ctx.translate(map_state.offset_x, map_state.offset_y);
    ctx.scale(map_state.scale, map_state.scale);

    for (const feature of map_state.features) {
      drawFeature(ctx, feature);
    }

    ctx.restore();

    drawFlagStand(ctx, dpr);

    if (state.revealed) {
      drawGuessLine(ctx, dpr);
      drawActualPin(ctx, dpr);
    }
  }

  function drawFlagStand(ctx, dpr) {
    if (!state.guess) return;

    const cp = getCanvasPointFromWorldPoint(state.guess);
    const pole_height = 46;
    const flag_width = 26;
    const flag_height = 18;
    const { width, height } = map_state;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pole_top = cp.y - pole_height;
    const text_y = cp.y + 8;

    // Pole
    ctx.beginPath();
    ctx.moveTo(cp.x, cp.y);
    ctx.lineTo(cp.x, pole_top);
    ctx.strokeStyle = "#5a3d2b";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.stroke();

    // Small knob at pole top
    ctx.beginPath();
    ctx.arc(cp.x, pole_top, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#5a3d2b";
    ctx.fill();

    // Flag
    ctx.fillStyle = "#d94b4b";
    ctx.beginPath();
    ctx.moveTo(cp.x + 3, pole_top + 2);
    ctx.lineTo(cp.x + 3 + flag_width, pole_top + flag_height / 2);
    ctx.lineTo(cp.x + 3, pole_top + flag_height);
    ctx.closePath();
    ctx.fill();

    // Base/ground point marker
    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#5a3d2b";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Coordinate text
    const lng_dir = state.guess.lng >= 0 ? "E" : "W";
    const lat_dir = state.guess.lat >= 0 ? "N" : "S";
    const text = `${Math.abs(state.guess.lat).toFixed(4)}° ${lat_dir}, ${Math.abs(state.guess.lng).toFixed(4)}° ${lng_dir}`;
    ctx.font = "bold 12px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const metrics = ctx.measureText(text);
    const pad_x = 6;
    const pad_y = 3;
    const text_x = Math.max(60, Math.min(width - 60, cp.x));

    // Text background
    ctx.fillStyle = "rgba(255, 255, 255, 0.88)";
    ctx.beginPath();
    const bg_w = metrics.width + pad_x * 2;
    const bg_h = 18 + pad_y * 2;
    const bg_x = text_x - bg_w / 2;
    const bg_y = text_y - 1;
    const r = 4;
    ctx.moveTo(bg_x + r, bg_y);
    ctx.lineTo(bg_x + bg_w - r, bg_y);
    ctx.quadraticCurveTo(bg_x + bg_w, bg_y, bg_x + bg_w, bg_y + r);
    ctx.lineTo(bg_x + bg_w, bg_y + bg_h - r);
    ctx.quadraticCurveTo(bg_x + bg_w, bg_y + bg_h, bg_x + bg_w - r, bg_y + bg_h);
    ctx.lineTo(bg_x + r, bg_y + bg_h);
    ctx.quadraticCurveTo(bg_x, bg_y + bg_h, bg_x, bg_y + bg_h - r);
    ctx.lineTo(bg_x, bg_y + r);
    ctx.quadraticCurveTo(bg_x, bg_y, bg_x + r, bg_y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#1d252c";
    ctx.fillText(text, text_x, text_y + pad_y);

    ctx.restore();
  }

  function drawGuessLine(ctx, dpr) {
    if (!state.guess) return;

    const round = currentRound();
    const actual_world = projectLngLat(round.lng, round.lat);
    const actual_cp = getCanvasPointFromWorldPoint(actual_world);
    const guess_cp = getCanvasPointFromWorldPoint(state.guess);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.beginPath();
    ctx.moveTo(guess_cp.x, guess_cp.y);
    ctx.lineTo(actual_cp.x, actual_cp.y);
    ctx.strokeStyle = "rgba(39, 174, 96, 0.5)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  function drawActualPin(ctx, dpr) {
    const round = currentRound();
    const world_point = projectLngLat(round.lng, round.lat);
    const cp = getCanvasPointFromWorldPoint(world_point);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 10, 0, Math.PI * 2);
    ctx.strokeStyle = "#27ae60";
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(39, 174, 96, 0.25)";
    ctx.fill();
    ctx.strokeStyle = "#27ae60";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cp.x, cp.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#27ae60";
    ctx.fill();

    ctx.restore();
  }

  function drawFeature(ctx, feature) {
    ctx.beginPath();

    let visible_ring_count = 0;
    for (const polygon of feature.polygons) {
      for (const ring of polygon) {
        drawRingPath(ctx, getRingPointsForScale(ring));
        visible_ring_count += 1;
      }
    }

    if (!visible_ring_count) return;

    ctx.fillStyle = getFeatureFill(feature);
    ctx.strokeStyle = getFeatureStroke(feature);
    ctx.lineWidth = getWorldBorderWidth();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.fill("evenodd");
    ctx.stroke();
  }

  function getRingPointsForScale(ring) {
    const zoom_ratio = map_state.scale / map_state.fit_scale;

    if (zoom_ratio >= MAP_ORIGINAL_DETAIL_ZOOM_RATIO) {
      return ring.points_by_detail.original;
    }

    if (zoom_ratio >= MAP_LIGHT_DETAIL_ZOOM_RATIO) {
      return ring.points_by_detail.light;
    }

    return ring.points_by_detail.modest;
  }

  function drawRingPath(ctx, points) {
    if (points.length < 3) return;

    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length; i += 1) {
      ctx.lineTo(points[i].x, points[i].y);
    }

    ctx.closePath();
  }

  function getFeatureFill(feature) {
    const colors = [
      "#e2efe7",
      "#d7e9ef",
      "#e9ead7",
      "#e7dfef",
      "#f0e3dc",
      "#dbeedc",
      "#efe3c7",
      "#d9e1f0"
    ];
    const color_index = feature.color_index || 0;

    return colors[color_index % colors.length];
  }

  function getFeatureStroke(feature) {
    const strokes = [
      "#4e7567",
      "#4f7080",
      "#75724f",
      "#6e6280",
      "#80695e",
      "#5d765d",
      "#806f42",
      "#586b86"
    ];
    const color_index = feature.color_index || 0;

    return strokes[color_index % strokes.length];
  }

  function getMapPaletteSize() {
    return 8;
  }

  function getWorldBorderWidth() {
    const visual_width = clamp(0.7 + Math.log2(map_state.scale / map_state.fit_scale + 1) * 0.18, 0.7, 1.55);

    return visual_width / map_state.scale;
  }

  async function setRound(index) {
    if (state.revealed) {
      state.results_cache.set(state.round_index, {
        guess: state.guess,
        guess_area: state.guess_area,
        distance: state.distance,
        round_score: state.round_score,
        answer: answerFromRound(currentRound())
      });
    }

    const next_index = Math.max(0, Math.min(index, rounds.length - 1));
    if (next_index === state.round_index) return;

    elements.previous_round_button.disabled = true;
    elements.next_round_button.disabled = true;
    await decodeRoundImage(next_index);

    state.round_index = next_index;

    const cached = state.results_cache.get(state.round_index);
    if (cached) {
      Object.assign(currentRound(), cached.answer);
      state.guess = cached.guess;
      state.guess_area = cached.guess_area;
      state.distance = cached.distance;
      state.round_score = cached.round_score;
      state.guess_placed = !!cached.guess;
      state.guess_lookup_id += 1;
      state.revealed = true;
    } else {
      resetRoundFlags();
    }

    render();
    requestMapDraw();
    decodeRoundsAhead(state.round_index).catch((error) => {
      console.warn("Could not decode later rounds:", error);
    });
  }

  async function submitGuess() {
    if (!state.guess_placed || state.revealed || state.submitting_guess) return;

    state.submitting_guess = true;
    renderGuessControls();
    let submission_error = "";

    try {
      const payload = await fetchApiJson(
        `api/matches/${encodeURIComponent(state.match_id)}/rounds/${state.round_index}/guess`,
        {
          method: "POST",
          body: JSON.stringify({ guess: state.guess })
        }
      );
      const result = payload.result;
      Object.assign(currentRound(), {
        title: result.title,
        province: result.province,
        lat: result.lat,
        lng: result.lng
      });
      state.distance = result.distance;
      state.round_score = result.roundScore;
      state.score = result.totalScore;
      state.revealed = true;
      state.results_cache.set(state.round_index, {
        guess: state.guess,
        guess_area: state.guess_area,
        distance: state.distance,
        round_score: state.round_score,
        answer: answerFromRound(currentRound())
      });

      if (payload.finished) stopMatchTimer();
      render();
      requestMapDraw();
      decodeRoundsAhead(state.round_index + 1).catch((error) => {
        console.warn("Could not decode later rounds:", error);
      });
    } catch (error) {
      console.error("Guess submission failed:", error);
      submission_error = "Không thể gửi dự đoán. Hãy thử lại.";
    } finally {
      state.submitting_guess = false;
      renderGuessControls();
      if (submission_error) elements.guess_status.textContent = submission_error;
    }
  }

  function answerFromRound(round) {
    return {
      title: round.title,
      province: round.province,
      lat: round.lat,
      lng: round.lng
    };
  }

  function resetGameState() {
    stopMatchTimer();
    state.round_index = 0;
    state.score = 0;
    state.seconds = 0;
    state.results_cache.clear();
    state.submitting_guess = false;
    resetRoundFlags();
  }

  function startMatchTimer() {
    stopMatchTimer();
    const local_started_at = Date.now();

    function updateTimer() {
      state.seconds = Math.floor((Date.now() - local_started_at) / 1000);
      elements.timer_value.textContent = formatTime(state.seconds);
    }

    updateTimer();
    state.timer_id = window.setInterval(() => {
      updateTimer();
    }, 250);
  }

  function stopMatchTimer() {
    if (state.timer_id !== null) {
      window.clearInterval(state.timer_id);
      state.timer_id = null;
    }
  }

  async function startStandardMatch() {
    const run_id = ++preparation_run_id;
    resetGameState();
    releaseRoundImages();
    rounds.splice(0, rounds.length);
    state.match_id = null;
    state.match_started_at = null;

    elements.mode_menu.hidden = true;
    elements.game_app.hidden = false;
    showPreparation("Đang tạo trận đấu...", 0, STANDARD_MATCH_ROUND_COUNT);
    elements.standard_match_button.disabled = true;

    try {
      const map_ready = ensureMapReady();
      const [match] = await Promise.all([
        fetchApiJson("api/matches", {
          method: "POST",
          body: JSON.stringify({ mode: "standard" })
        }),
        map_ready
      ]);
      if (run_id !== preparation_run_id) return;

      state.match_id = match.matchId;
      const image_width = preferredRoundImageWidth();
      rounds.push(
        ...match.rounds.slice(0, STANDARD_MATCH_ROUND_COUNT).map((round) => ({
          index: round.index,
          image_path: round.imagePath,
          image_width
        }))
      );

      showPreparation("Đang tải ảnh cho trận đấu...", 0, rounds.length);
      await Promise.all([
        preloadRoundImages((completed, total) => {
          if (run_id === preparation_run_id) {
            showPreparation("Đang tải ảnh cho trận đấu...", completed, total);
          }
        }),
        decodeRoundsAhead(0)
      ]);
      if (run_id !== preparation_run_id) return;

      showPreparation("Đang hoàn tất...", rounds.length, rounds.length);
      const ready = await fetchApiJson(
        `api/matches/${encodeURIComponent(state.match_id)}/ready`,
        { method: "POST", body: "{}" }
      );
      if (run_id !== preparation_run_id) return;

      state.match_started_at = ready.startedAt;
      hidePreparation();
      render();
      requestMapDraw();
      startMatchTimer();
    } catch (error) {
      if (run_id !== preparation_run_id) return;
      console.error("Match preparation failed:", error);
      showPreparationError(error.message || "Không thể chuẩn bị trận đấu.");
    } finally {
      if (run_id === preparation_run_id) elements.standard_match_button.disabled = false;
    }
  }

  function ensureMapReady() {
    if (!map_initialized) {
      map_initialized = true;
      return setupMap();
    }

    resizeMapCanvas();
    if (map_state.features.length) {
      fitMapToCanvas();
      updateMapCenterReadout();
      updateGuessMarkerPosition();
      requestMapDraw();
      return Promise.resolve();
    }

    map_load_promise = loadMapData();
    return map_load_promise;
  }

  function showPreparation(message, completed, total) {
    const progress = total ? Math.round((completed / total) * 100) : 0;
    elements.preparation.hidden = false;
    elements.preparation_status.textContent = message;
    elements.preparation_progress.value = progress;
    elements.preparation_count.textContent = total ? `${completed}/${total}` : "";
    elements.preparation_retry_button.hidden = true;
  }

  function showPreparationError(message) {
    elements.preparation.hidden = false;
    elements.preparation_status.textContent = message;
    elements.preparation_retry_button.hidden = false;
  }

  function hidePreparation() {
    elements.preparation.hidden = true;
    elements.preparation_retry_button.hidden = true;
  }

  function showModeMenu() {
    preparation_run_id += 1;
    stopMatchTimer();
    hidePreparation();
    releaseRoundImages();
    rounds.splice(0, rounds.length);
    state.match_id = null;
    elements.game_app.hidden = true;
    elements.mode_menu.hidden = false;
  }

  elements.round_image.addEventListener("load", () => {
    elements.image_fallback.classList.add("hidden");
  });

  elements.round_image.addEventListener("error", () => {
    elements.image_fallback.classList.remove("hidden");
  });

  elements.previous_round_button.addEventListener("click", () => {
    setRound(state.round_index - 1).catch((error) => console.error("Round change failed:", error));
  });

  elements.next_round_button.addEventListener("click", () => {
    setRound(state.round_index + 1).catch((error) => console.error("Round change failed:", error));
  });

  elements.place_guess_button.addEventListener("click", () => {
    if (map_state.skip_next_guess_tool_click) {
      map_state.skip_next_guess_tool_click = false;
      return;
    }

    if (state.revealed) return;
    placeGuessAtDefaultPoint();
  });

  elements.clear_guess_button.addEventListener("click", () => {
    clearGuess();
  });

  elements.submit_button.addEventListener("click", submitGuess);

  elements.restart_button.addEventListener("click", startStandardMatch);
  elements.standard_match_button.addEventListener("click", startStandardMatch);
  elements.back_to_menu_button.addEventListener("click", showModeMenu);
  elements.preparation_retry_button.addEventListener("click", startStandardMatch);
  elements.preparation_cancel_button.addEventListener("click", showModeMenu);

  window.addEventListener("beforeunload", () => {
    releaseRoundImages();
  });

  // The authenticated user starts on the mode menu. Map data and the timer
  // remain idle until Standard Match is selected.
})();
