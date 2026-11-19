(() => {
  "use strict";

  const FADE_MS = 320;
  const FRAME_MS = 1500;
  const FRAME_PADDING = 0.07;
  const MAX_ZOOM = 1.75;
  const STAGE_BACKGROUND = "#ffffff";
  const SHARE_WIDTH = 1600;
  const SHARE_HEIGHT = 1120;
  const SHARE_BAND = 220;
  const SHARE_MARGIN = 72;
  const SWIPE_DISTANCE = 40;
  const FONT_STACK = 'Archivo, "Helvetica Neue", Helvetica, Arial, sans-serif';
  const ARROW =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const CHEVRON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  const state = {
    model: null,
    roof: "box",
    tier: "freedom",
    palette: "A",
    upgrades: new Set(),
    customer: {},
    errors: {},
    submitted: false,
    sending: false,
    sendError: "",
    step: 0,
  };

  const gallery = { items: [], index: 0, model: "", palette: "", token: 0, swipeStart: null };
  const share = { key: "", canvas: null, file: null, token: null, message: "" };

  let config = null;
  let money = null;
  let layerSuffix = "";
  let playback = null;
  let framedBounds = null;
  const manifests = new Map();
  const galleries = new Map();
  const slots = new Map();
  const prefetched = new Set();

  const byId = (id) => document.getElementById(id);

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) {
        continue;
      }
      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key === "html") {
        node.innerHTML = value;
      } else if (key.startsWith("on")) {
        node.addEventListener(key.slice(2), value);
      } else {
        node.setAttribute(key, value === true ? "" : value);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) {
        node.append(child instanceof Node ? child : String(child));
      }
    }
    return node;
  }

  const findModel = (id) => config.models.find((item) => item.id === id);
  const currentModel = () => findModel(state.model);
  const collectionOf = (model) => config.collections.find((item) => item.id === model.collection);
  const findRoof = (id) => config.roofs.find((item) => item.id === id);
  const findTier = (id) => config.tiers.find((item) => item.id === id);
  const findPalette = (id) => config.palettes.find((item) => item.id === id);
  const findUpgrade = (id) => config.upgrades.find((item) => item.id === id);
  const availableTiers = () => collectionOf(currentModel()).tiers.map(findTier);
  const formatPrice = (value) => money.format(value);
  const formatNumber = (value) => String(Math.round(value * 10) / 10);

  function isAvailable(model) {
    const manifest = manifests.get(model.id);
    return Boolean(manifest && manifest.layers && !(manifest.missing || []).length);
  }

  function defaultModelId() {
    const preferred = config.defaultModel && findModel(config.defaultModel);
    if (preferred && isAvailable(preferred)) {
      return preferred.id;
    }
    return config.models.find(isAvailable)?.id || null;
  }

  function layerBounds(name) {
    return manifests.get(state.model)?.layers?.[name]?.bounds || null;
  }

  function isRequired(item) {
    return item.requiredOver !== undefined && currentModel().floorArea > item.requiredOver;
  }

  function enforceRules() {
    if (!availableTiers().some((tier) => tier.id === state.tier)) {
      state.tier = availableTiers()[0].id;
    }
    for (const item of config.upgrades) {
      if (item.requiredOver !== undefined) {
        if (isRequired(item)) {
          state.upgrades.add(item.id);
        }
      }
    }
  }

  function claddingFor(upgrades) {
    for (const id of upgrades) {
      if (findUpgrade(id)?.group === "cladding") {
        return config.claddingLayers[id];
      }
    }
    return config.claddingLayers.default;
  }

  function claddingName(upgrades) {
    for (const id of upgrades) {
      const item = findUpgrade(id);
      if (item?.group === "cladding") {
        return item.name;
      }
    }
    return "Standard vertical timber";
  }

  function roofTitle(roof) {
    return roof.label ? `${roof.name.toUpperCase()} - ${roof.label}` : roof.name.toUpperCase();
  }

  function roofSummary(roof, model = currentModel()) {
    const pitch = model.roofPitch?.[roof.id];
    if (pitch !== undefined && roof.pitchSummary) {
      return roof.pitchSummary.replace("{pitch}", formatNumber(pitch));
    }
    return roof.summary;
  }

  function tierTitle(tier) {
    return `${tier.name.toUpperCase()} - ${tier.label}`;
  }

  function modelTitle(model) {
    return `The ${model.name} | ${model.floorArea}`;
  }

  function gstNote() {
    return config.pricesIncludeGst ? "All prices are in NZD and include GST." : "All prices are in NZD.";
  }

  function pricing() {
    const model = currentModel();
    const roof = findRoof(state.roof);
    const tier = findTier(state.tier);
    const palette = findPalette(state.palette);
    const base = model.floorArea * tier.ratePerSqm;
    const roofCost = model.floorArea * roof.ratePerSqm;
    const included = [
      { id: "model", title: modelTitle(model), includes: config.modelIncludes, value: base },
      {
        id: "roof",
        title: roofTitle(roof),
        summary: roofSummary(roof),
        value: roofCost,
        display: roofCost ? null : "Included",
      },
      { id: "tier", title: tierTitle(tier), summary: tier.summary, value: 0, display: "Included" },
      {
        id: "palette",
        title: palette.name.toUpperCase(),
        summary: palette.summary,
        value: 0,
        display: "Included",
      },
    ];
    const optional = config.upgrades
      .filter((item) => state.upgrades.has(item.id))
      .map((item) => ({
        id: item.id,
        title: item.name,
        summary: item.summary,
        includes: item.includes,
        value: item.price,
        display: item.price === null ? "POA" : null,
      }));
    const total = [...included, ...optional].reduce(
      (sum, line) => sum + (typeof line.value === "number" ? line.value : 0),
      0,
    );
    return { included, optional, total, hasPoa: optional.some((line) => line.value === null) };
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const model = findModel(params.get("model"));
    if (model && isAvailable(model)) {
      state.model = model.id;
    }
    if (findRoof(params.get("roof"))) {
      state.roof = params.get("roof");
    }
    if (findTier(params.get("tier"))) {
      state.tier = params.get("tier");
    }
    if (findPalette(params.get("palette"))) {
      state.palette = params.get("palette");
    }
    state.upgrades = new Set();
    for (const id of (params.get("upgrades") || "").split(",").filter((value) => findUpgrade(value))) {
      toggleUpgrade(id, true);
    }
  }

  function writeHash() {
    const params = new URLSearchParams({
      model: state.model,
      roof: state.roof,
      tier: state.tier,
      palette: state.palette,
    });
    if (state.upgrades.size) {
      params.set("upgrades", [...state.upgrades].join(","));
    }
    history.replaceState(null, "", `#${params.toString()}`);
  }

  function toggleUpgrade(id, force) {
    const item = findUpgrade(id);
    if (isRequired(item)) {
      state.upgrades.add(id);
      return;
    }
    const selected = force ?? !state.upgrades.has(id);
    if (selected && item.group) {
      for (const other of config.upgrades) {
        if (other.group === item.group) {
          state.upgrades.delete(other.id);
        }
      }
    }
    if (selected) {
      state.upgrades.add(id);
    } else {
      state.upgrades.delete(id);
    }
  }

  function matches(entry, upgrades) {
    return (entry.when || []).every((id) => upgrades.has(id)) && !(entry.unless || []).some((id) => upgrades.has(id));
  }

  function fill(source, view) {
    const values = { roof: view.roof, palette: view.palette, cladding: claddingFor(view.upgrades) };
    return source.replace(/\{(\w+)\}/g, (match, key) => values[key]);
  }

  function resolveStack(view) {
    return config.stack
      .filter((entry) => matches(entry, view.upgrades))
      .map((entry) => ({ slot: entry.slot, name: fill(entry.src, view) }));
  }

  const slotOrder = () => [...new Set(config.stack.map((entry) => entry.slot))];

  function layerUrl(name, full = false) {
    return `${currentModel().layers}${name}${full ? "" : layerSuffix}.webp`;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Could not load ${url}`));
      image.src = url;
    });
  }

  function retire(image) {
    image.classList.remove("is-visible");
    window.setTimeout(() => image.remove(), FADE_MS + 40);
  }

  function setStatus(text) {
    const status = byId("stage-status");
    status.textContent = text;
    status.hidden = !text;
  }

  function mergeBounds(union, bounds) {
    if (!bounds) {
      return union;
    }
    return union
      ? [
          Math.min(union[0], bounds[0]),
          Math.min(union[1], bounds[1]),
          Math.max(union[2], bounds[2]),
          Math.max(union[3], bounds[3]),
        ]
      : [...bounds];
  }

  function unionBounds(layers) {
    return layers.reduce(
      (union, layer) => (layer.slot === "shadow" ? union : mergeBounds(union, layerBounds(layer.name))),
      null,
    );
  }

  function imageRect(width, height) {
    const model = currentModel();
    const aspect = model.imageWidth / model.imageHeight;
    if (width / height > aspect) {
      return { x: (width - height * aspect) / 2, y: 0, width: height * aspect, height };
    }
    return { x: 0, y: (height - width / aspect) / 2, width, height: width / aspect };
  }

  function frameStage(bounds, animate = true) {
    const container = byId("stage-layers");
    framedBounds = bounds;
    if (!bounds) {
      container.style.transform = "";
      return;
    }
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) {
      return;
    }
    const rect = imageRect(width, height);
    const left = rect.x + bounds[0] * rect.width;
    const top = rect.y + bounds[1] * rect.height;
    const right = rect.x + bounds[2] * rect.width;
    const bottom = rect.y + bounds[3] * rect.height;
    const scale = Math.max(
      1,
      Math.min(
        MAX_ZOOM,
        (width * (1 - 2 * FRAME_PADDING)) / (right - left),
        (height * (1 - 2 * FRAME_PADDING)) / (bottom - top),
      ),
    );
    const shiftX = width / 2 - scale * ((left + right) / 2);
    const shiftY = height / 2 - scale * ((top + bottom) / 2);
    container.classList.toggle("is-instant", !animate);
    container.style.transform = `translate(${shiftX.toFixed(1)}px, ${shiftY.toFixed(1)}px) scale(${scale.toFixed(4)})`;
  }

  function renderStage(view, label) {
    const container = byId("stage-layers");
    const layers = resolveStack(view);
    const wanted = new Map(layers.map((layer) => [layer.slot, layerUrl(layer.name)]));
    frameStage(unionBounds(layers));
    let pending = 0;
    slotOrder().forEach((slot, index) => {
      const url = wanted.get(slot);
      const current = slots.get(slot);
      if (current && current.url === url) {
        return;
      }
      if (!url) {
        if (current) {
          container.querySelectorAll(`img[data-slot="${slot}"]`).forEach(retire);
          slots.delete(slot);
        }
        return;
      }
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.dataset.slot = slot;
      image.style.zIndex = String(index + 1);
      const record = { url, image };
      slots.set(slot, record);
      pending += 1;
      setStatus("Loading");
      image.onload = () => {
        pending -= 1;
        if (pending === 0) {
          setStatus("");
        }
        if (slots.get(slot) !== record) {
          return;
        }
        const previous = [...container.querySelectorAll(`img[data-slot="${slot}"]`)];
        container.append(image);
        requestAnimationFrame(() => image.classList.add("is-visible"));
        window.setTimeout(() => previous.forEach(retire), FADE_MS);
      };
      image.onerror = () => {
        pending -= 1;
        setStatus(pending === 0 ? "Image missing" : "Loading");
      };
      image.src = url;
    });
    updateCaption(view, label);
  }

  function describe(view) {
    const roof = findRoof(view.roof);
    const palette = findPalette(view.palette);
    const upgrades = [...view.upgrades]
      .map((id) => findUpgrade(id))
      .filter((item) => !item.id.endsWith("consent") && item.id !== "transport")
      .map((item) => item.name.toLowerCase());
    return (
      `The ${currentModel().name} with a ${roof.name.toLowerCase()} roof in ${palette.name}` +
      (upgrades.length ? `, with ${upgrades.join(", ")}` : "")
    );
  }

  function designLine(view = state) {
    return `The ${currentModel().name} / ${findRoof(view.roof).name} roof / ${findPalette(view.palette).name}`;
  }

  function updateCaption(view, label) {
    const caption = byId("stage-caption");
    if (label) {
      caption.replaceChildren(h("strong", { text: "Watch it build" }), ` / ${label}`);
    } else {
      caption.replaceChildren(
        h("strong", { text: `The ${currentModel().name}` }),
        ` / ${findRoof(view.roof).name} roof / ${findPalette(view.palette).name}`,
      );
    }
    byId("stage-layers").setAttribute("aria-label", describe(view));
  }

  function prefetch(names) {
    const queue = names.map((name) => layerUrl(name)).filter((url) => !prefetched.has(url));
    const next = () => {
      const url = queue.shift();
      if (!url) {
        return;
      }
      prefetched.add(url);
      loadImage(url)
        .catch(() => {})
        .finally(next);
    };
    next();
    next();
  }

  function prefetchForStep(index) {
    const id = config.steps[index]?.id;
    const names = [];
    if (id === "roof") {
      for (const roof of config.roofs) {
        for (const layer of resolveStack({ ...state, roof: roof.id })) {
          names.push(layer.name);
        }
      }
    } else if (id === "palette") {
      for (const palette of config.palettes) {
        for (const layer of resolveStack({ ...state, palette: palette.id })) {
          names.push(layer.name);
        }
      }
    } else if (id === "upgrades") {
      const everything = new Set(config.upgrades.map((item) => item.id));
      everything.delete("aluminium");
      for (const layer of resolveStack({ ...state, upgrades: everything })) {
        names.push(layer.name);
      }
      for (const variant of ["abodo", "aluminium"]) {
        names.push(`house_${state.roof}_${state.palette}_${variant}`);
      }
    }
    if (names.length) {
      window.setTimeout(() => prefetch([...new Set(names)]), 500);
    }
  }

  async function loadGallery(model) {
    if (!model.gallery) {
      return null;
    }
    if (!galleries.has(model.id)) {
      galleries.set(
        model.id,
        loadJson(`${model.gallery}gallery.json`).catch(() => null),
      );
    }
    return galleries.get(model.id);
  }

  function galleryItems(model, data) {
    const darkUrban = findPalette("A");
    const items = (data.exterior || []).map((entry) => ({
      ...entry,
      group: "Exterior",
      caption: `The ${model.name} in ${darkUrban.name}: ${entry.caption}`,
    }));
    const interiors = data.interior || {};
    const key = interiors[state.palette] ? state.palette : Object.keys(interiors)[0];
    const palette = findPalette(key);
    for (const entry of interiors[key] || []) {
      items.push({
        ...entry,
        group: "Interior",
        caption: `The ${model.name} in ${palette.name}: ${entry.caption}`,
      });
    }
    return items;
  }

  async function renderGallery() {
    const model = currentModel();
    if (gallery.model === model.id && gallery.palette === state.palette && gallery.items.length) {
      return;
    }
    const section = byId("inspiration");
    const token = ++gallery.token;
    const data = await loadGallery(model);
    if (token !== gallery.token) {
      return;
    }
    if (!data || !(data.exterior || []).length) {
      section.hidden = true;
      gallery.items = [];
      gallery.model = model.id;
      gallery.palette = state.palette;
      return;
    }
    section.hidden = false;
    const sameModel = gallery.model === model.id;
    const previous = gallery.items[gallery.index];
    gallery.items = galleryItems(model, data);
    gallery.model = model.id;
    gallery.palette = state.palette;
    let index = 0;
    if (sameModel && previous) {
      const slug = previous.file.split("/").pop();
      const kept = gallery.items.findIndex(
        (item) => item.group === previous.group && item.file.split("/").pop() === slug,
      );
      index = kept >= 0 ? kept : 0;
    }
    buildThumbs(model);
    showGalleryImage(index, sameModel);
  }

  function galleryUrl(model, item, thumb = false) {
    return `${model.gallery}${item.file}${thumb ? "-thumb" : ""}.jpg`;
  }

  function buildThumbs(model) {
    const groups = [...new Set(gallery.items.map((item) => item.group))];
    byId("carousel-groups").replaceChildren(
      ...groups.map((group) =>
        h(
          "button",
          {
            type: "button",
            class: "carousel-group",
            "data-group": group,
            onclick: () => showGalleryImage(gallery.items.findIndex((item) => item.group === group)),
          },
          `${group} (${gallery.items.filter((item) => item.group === group).length})`,
        ),
      ),
    );
    byId("carousel-thumbs").replaceChildren(
      ...gallery.items.map((item, index) =>
        h(
          "li",
          {},
          h(
            "button",
            {
              type: "button",
              class: "carousel-thumb",
              "aria-label": `Show ${item.caption}`,
              onclick: () => showGalleryImage(index),
            },
            h("img", {
              src: galleryUrl(model, item, true),
              alt: "",
              loading: "lazy",
              draggable: "false",
              width: "160",
              height: "90",
            }),
          ),
        ),
      ),
    );
  }

  function showGalleryImage(index, scrollThumb = true) {
    const count = gallery.items.length;
    if (!count) {
      return;
    }
    gallery.index = ((index % count) + count) % count;
    const model = currentModel();
    const item = gallery.items[gallery.index];
    const image = byId("carousel-image");
    const url = galleryUrl(model, item);
    image.classList.add("is-loading");
    loadImage(url)
      .then(() => {
        if (gallery.items[gallery.index] !== item) {
          return;
        }
        image.src = url;
        image.alt = item.caption;
        image.classList.toggle("is-portrait", item.height > item.width);
        image.classList.remove("is-loading");
      })
      .catch(() => {
        image.classList.remove("is-loading");
      });
    byId("carousel-caption").textContent = item.caption;
    byId("carousel-count").textContent = `${gallery.index + 1} / ${count}`;
    document.querySelectorAll(".carousel-group").forEach((button) => {
      button.classList.toggle("is-current", button.dataset.group === item.group);
    });
    const thumbs = byId("carousel-thumbs").querySelectorAll(".carousel-thumb");
    thumbs.forEach((button, thumbIndex) => {
      const current = thumbIndex === gallery.index;
      button.classList.toggle("is-current", current);
      button.setAttribute("aria-current", current ? "true" : "false");
      if (current && scrollThumb) {
        const strip = byId("carousel-thumbs");
        const left = button.offsetLeft - (strip.clientWidth - button.clientWidth) / 2;
        strip.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
      }
    });
    for (const neighbour of [gallery.index + 1, gallery.index - 1]) {
      const other = gallery.items[((neighbour % count) + count) % count];
      loadImage(galleryUrl(model, other)).catch(() => {});
    }
  }

  function reducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function bindGallery() {
    const frame = byId("carousel-frame");
    byId("carousel-prev").addEventListener("click", () => showGalleryImage(gallery.index - 1));
    byId("carousel-next").addEventListener("click", () => showGalleryImage(gallery.index + 1));
    byId("carousel").addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        showGalleryImage(gallery.index + (event.key === "ArrowLeft" ? -1 : 1));
      }
    });
    frame.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) {
        return;
      }
      gallery.swipeStart = { x: event.clientX, y: event.clientY };
    });
    frame.addEventListener("pointerup", (event) => {
      if (!gallery.swipeStart) {
        return;
      }
      const distanceX = event.clientX - gallery.swipeStart.x;
      const distanceY = event.clientY - gallery.swipeStart.y;
      gallery.swipeStart = null;
      if (Math.abs(distanceX) > SWIPE_DISTANCE && Math.abs(distanceX) > Math.abs(distanceY)) {
        showGalleryImage(gallery.index + (distanceX < 0 ? 1 : -1));
      }
    });
    frame.addEventListener("pointercancel", () => {
      gallery.swipeStart = null;
    });
    frame.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  function renderProgress() {
    const steps = config.steps;
    const last = state.step === steps.length - 1;
    byId("progress").replaceChildren(
      h(
        "p",
        { class: "progress-label" },
        h("span", { text: `Step ${state.step + 1} of ${steps.length}` }),
        h("span", { text: steps[state.step].label }),
      ),
      h(
        "ol",
        { class: "progress-track" },
        steps.map((step, index) =>
          h(
            "li",
            {},
            h("button", {
              type: "button",
              class: index === state.step ? "is-current" : index < state.step ? "is-done" : "",
              "aria-label": `Step ${index + 1}: ${step.label}`,
              "aria-current": index === state.step ? "step" : null,
              onclick: () => goToStep(index),
            }),
          ),
        ),
      ),
    );
    const next = byId("next-top");
    next.disabled = last;
    next.setAttribute("aria-label", last ? "Last step" : `Next: ${steps[state.step + 1].label}`);
  }

  function goToStep(index, options = {}) {
    const steps = config.steps;
    const target = Math.max(0, Math.min(steps.length - 1, index));
    stopPlayback();
    state.step = target;
    renderSteps({ keepScroll: false });
    renderProgress();
    prefetchForStep(target);
    const panel = byId("steps-panel");
    panel.scrollTop = 0;
    if (options.focus !== false) {
      byId("step-title")?.focus({ preventScroll: true });
    }
    if (window.matchMedia("(max-width: 1023px)").matches && options.scroll !== false) {
      const stageColumn = byId("stage-column");
      const top = panel.getBoundingClientRect().top + window.scrollY - stageColumn.offsetHeight - 8;
      window.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  function choice({ key, pressed, disabled, onclick, title, after, summary, extra, price, label, className }) {
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: className ? `choice ${className}` : "choice",
          "aria-pressed": pressed ? "true" : "false",
          "data-key": key,
          disabled,
          "aria-label": label || null,
          onclick,
        },
        h("span", { class: "choice-mark", "aria-hidden": "true" }),
        h(
          "span",
          { class: "choice-body" },
          h("span", { class: "choice-title" }, title, after),
          summary ? h("span", { class: "choice-summary", text: summary }) : null,
          extra,
          price ? h("span", { class: "choice-price", text: price }) : null,
        ),
      ),
    );
  }

  function titled(main, rest) {
    return [h("span", { class: "choice-name", text: main }), rest ? ` - ${rest}` : null];
  }

  function designStep() {
    const blocks = config.collections.map((collection) => {
      const models = config.models.filter((model) => model.collection === collection.id);
      return [
        h("h3", { class: "group-title", text: collection.name }),
        h(
          "ul",
          { class: "choice-grid", style: `--rows:${Math.ceil(models.length / 2)}` },
          models.map((model) => {
            const available = isAvailable(model);
            return choice({
              key: `model:${model.id}`,
              pressed: model.id === state.model,
              disabled: !available,
              className: "is-model",
              label: available ? null : `The ${model.name}, ${model.floorArea} square metres, coming soon`,
              onclick: () => selectModel(model.id),
              title: ["The ", h("strong", { text: model.name }), ` | ${model.floorArea}`],
              after: available ? null : h("span", { class: "choice-soon", text: "Coming soon" }),
            });
          }),
        ),
      ];
    });
    return [
      h(
        "p",
        { class: "lead" },
        h("strong", { text: "Explore our curated collection of architectural homes & commercial spaces" }),
        ", ranging from compact 25 m",
        h("sup", { text: "2" }),
        " layouts to generous 300 m",
        h("sup", { text: "2" }),
        " living / office spaces.",
      ),
      h("p", {
        class: "lead",
        text: "Each design is intentionally crafted to elevate everyday life and complement its natural surroundings.",
      }),
      blocks,
      h("p", {
        class: "note",
        text: "Designs marked coming soon join the configurator as their 3D models are completed.",
      }),
    ];
  }

  function roofStep() {
    return [
      h("p", { class: "lead" }, h("strong", { text: "Choose your favourite roof profile" })),
      h("p", {
        class: "lead",
        text: "Select our standard BOX roofing profile (included) or upgrade with our 3 premium roofing styles to get your favourite look.",
      }),
      h(
        "ul",
        { class: "choice-list" },
        config.roofs.map((roof) =>
          choice({
            key: `roof:${roof.id}`,
            pressed: roof.id === state.roof,
            onclick: () => select("roof", roof.id),
            title: titled(roof.name.toUpperCase(), roof.label),
            summary: roofSummary(roof),
          }),
        ),
      ),
    ];
  }

  function specificationStep() {
    const tiers = availableTiers();
    const bespoke = currentModel().collection === "bespoke";
    return [
      h(
        "p",
        { class: "lead" },
        "Select the perfect finish for your home. ",
        bespoke ? "Bespoke homes come in our " : "Choose from our ",
        h("strong", {
          text: bespoke
            ? `${tiers.length} premium specification tiers`
            : `${tiers.length} curated tiers of premium specifications`,
        }),
        " to match your lifestyle and budget.",
      ),
      h(
        "ul",
        { class: "choice-list" },
        tiers.map((tier) =>
          choice({
            key: `tier:${tier.id}`,
            pressed: tier.id === state.tier,
            onclick: () => select("tier", tier.id),
            title: titled(tier.name.toUpperCase(), tier.label),
            summary: tier.summary,
          }),
        ),
      ),
      bespoke
        ? h("p", {
            class: "note",
            text: "Classic is not offered on the Bespoke Collection, as these are premium homes.",
          })
        : null,
    ];
  }

  function paletteStep() {
    return [
      h(
        "p",
        { class: "lead" },
        h("strong", { text: "Select from our 3 award-winning exterior & interior colour palettes." }),
        " Each pairs an exterior cladding with a matching interior, so the inside and outside bring your home together.",
      ),
      h(
        "ul",
        { class: "choice-list" },
        config.palettes.map((palette) =>
          choice({
            key: `palette:${palette.id}`,
            pressed: palette.id === state.palette,
            onclick: () => select("palette", palette.id),
            title: h("span", { class: "choice-name", text: palette.name.toUpperCase() }),
            after: h(
              "span",
              { class: "swatches", "aria-hidden": "true" },
              palette.swatches.map((color) => h("span", { style: `background:${color}` })),
            ),
            summary: palette.summary,
          }),
        ),
      ),
    ];
  }

  function includesList(items) {
    return items?.length
      ? h(
          "span",
          { class: "includes" },
          h("span", { class: "includes-title", text: "Includes" }),
          h(
            "ul",
            {},
            items.map((item) => h("li", { text: item })),
          ),
        )
      : null;
  }

  function upgradesStep() {
    const groups = config.upgradeGroups.map((group) => [
      h("h3", { class: "group-title is-muted", text: group.title }),
      group.ids.some((id) => findUpgrade(id).group === "cladding")
        ? h("p", { class: "note", text: "Choose one cladding upgrade. Window shrouds & screens go with either." })
        : null,
      h(
        "ul",
        { class: "choice-list" },
        group.ids.map((id) => {
          const item = findUpgrade(id);
          const required = isRequired(item);
          return choice({
            key: `upgrade:${id}`,
            pressed: state.upgrades.has(id),
            disabled: required,
            onclick: () => {
              stopPlayback();
              toggleUpgrade(id);
              render();
            },
            title: h("span", { class: "choice-name", text: item.name }),
            after: item.note
              ? h("span", { class: "choice-note", text: required ? "Required for this design" : `(${item.note})` })
              : null,
            summary: item.summary,
            extra: includesList(item.includes),
            price: item.price === null ? item.priceLabel : `Starting from ${formatPrice(item.price)}`,
          });
        }),
      ),
    ]);
    return [
      h("p", { class: "lead" }, h("strong", { text: "Make it your home, your own." })),
      h("p", {
        class: "lead",
        text: "Select from our range of premium upgrades and customise your new home to your lifestyle & budget (estimates only, including GST).",
      }),
      groups,
    ];
  }

  function estimateRow(line) {
    return h(
      "li",
      { class: "estimate-row" },
      h("span", { class: "choice-mark is-on", "aria-hidden": "true" }),
      h(
        "span",
        { class: "estimate-body" },
        h("span", { class: "estimate-title" }, line.id === "model" ? modelHeading() : line.title),
        line.summary ? h("span", { class: "choice-summary", text: line.summary }) : null,
        includesList(line.includes),
      ),
      h("span", { class: "estimate-price", text: line.display ?? formatPrice(line.value) }),
    );
  }

  function modelHeading() {
    const model = currentModel();
    return ["The ", h("strong", { text: model.name }), ` | ${model.floorArea}`];
  }

  function estimateStep() {
    const summary = pricing();
    return [
      h("p", { class: "lead" }, h("strong", { text: "What's included:" })),
      h("ul", { class: "estimate" }, summary.included.map(estimateRow)),
      h("p", { class: "lead estimate-subtitle" }, h("strong", { text: "Optional upgrades selected:" })),
      summary.optional.length
        ? h("ul", { class: "estimate" }, summary.optional.map(estimateRow))
        : h("p", { class: "note", text: "No optional upgrades selected yet." }),
      h(
        "p",
        { class: "estimate-total" },
        h("span", { text: "Your New Home Estimate" }),
        h("strong", { text: formatPrice(summary.total) }),
      ),
      h("p", { class: "estimate-gst", text: gstNote() }),
      summary.hasPoa ? h("p", { class: "note", text: "Plus transport & delivery, priced on application." }) : null,
    ];
  }

  function field(definition) {
    const error = state.errors[definition.id];
    const value = state.customer[definition.id] || "";
    const common = {
      id: `field-${definition.id}`,
      name: definition.id,
      required: definition.required || null,
      "aria-invalid": error ? "true" : "false",
      "aria-describedby": error ? `error-${definition.id}` : null,
      oninput: (event) => {
        state.customer[definition.id] = event.target.value;
      },
      onchange: (event) => {
        state.customer[definition.id] = event.target.value;
      },
    };
    let control;
    if (definition.type === "select") {
      control = h(
        "select",
        common,
        h("option", { value: "", text: "Select", selected: !value }),
        definition.options.map((option) => h("option", { value: option, text: option, selected: option === value })),
      );
    } else if (definition.type === "textarea") {
      control = h("textarea", { ...common, rows: "4" }, value);
    } else {
      control = h("input", {
        ...common,
        type: definition.type,
        autocomplete: definition.autocomplete || null,
        inputmode: definition.type === "number" ? "numeric" : null,
        min: definition.type === "number" ? "10" : null,
        value,
      });
    }
    return h(
      "div",
      { class: `field${definition.type === "textarea" ? " is-wide" : ""}${error ? " has-error" : ""}` },
      h("label", { for: `field-${definition.id}`, text: `${definition.label}${definition.required ? "*" : ""}` }),
      control,
      error ? h("p", { class: "field-error", id: `error-${definition.id}`, text: error }) : null,
    );
  }

  function detailsStep() {
    if (state.submitted) {
      return [confirmation(), shareBlock()];
    }
    return [
      h("p", { class: "lead" }, h("strong", { text: "Where should we send your New Home design?" })),
      state.sendError ? h("p", { class: "banner is-error", role: "alert", text: state.sendError }) : null,
      h(
        "form",
        {
          class: "form-grid",
          novalidate: true,
          onsubmit: (event) => {
            event.preventDefault();
            submit();
          },
        },
        config.detailFields.map(field),
        h(
          "div",
          { class: "form-actions" },
          h(
            "button",
            { class: "send-button", type: "submit", disabled: state.sending || null },
            state.sending ? "Sending" : "Send my design",
            h("span", { class: "send-arrow", html: ARROW }),
          ),
          h("p", {
            class: "note",
            text: "By sending, you agree to NOOK contacting you about this design.",
          }),
        ),
      ),
      shareBlock(),
    ];
  }

  function summaryRows() {
    const model = currentModel();
    const summary = pricing();
    const upgrades = config.upgrades
      .filter((item) => state.upgrades.has(item.id) && item.group !== "cladding")
      .map((item) => item.name);
    return [
      ["Design", `${modelTitle(model)} sq m (${collectionOf(model).name})`],
      ["Roof", roofTitle(findRoof(state.roof))],
      ["Specification", tierTitle(findTier(state.tier))],
      ["Colour palette", findPalette(state.palette).name],
      ["Cladding", claddingName(state.upgrades)],
      ["Upgrades", upgrades.length ? upgrades.join(", ") : "None"],
      [
        "Your New Home Estimate",
        formatPrice(summary.total) +
          (config.pricesIncludeGst ? " incl. GST" : "") +
          (summary.hasPoa ? " plus transport (POA)" : ""),
      ],
    ];
  }

  function confirmation() {
    const testMode = !config.submitEndpoint;
    return h(
      "div",
      { class: "confirmation" },
      testMode
        ? h("p", {
            class: "banner",
            role: "status",
            text: "Test build: no email was sent. On the live site your design goes to you and to the NOOK team.",
          })
        : null,
      h("p", { class: "confirm-title", text: "Your design is on its way to your inbox!" }),
      h("p", { class: "lead", text: "We'll be in touch soon to chat about bringing it to life." }),
      h(
        "dl",
        { class: "summary-list" },
        summaryRows().map(([term, value]) => [h("dt", { text: term }), h("dd", { text: value })]),
        h("dt", { text: "Name" }),
        h("dd", { text: state.customer.name || "" }),
        h("dt", { text: "Email" }),
        h("dd", { text: state.customer.email || "" }),
      ),
      h(
        "div",
        { class: "summary-actions" },
        h("button", { class: "link-button", type: "button", text: "Start a new design", onclick: restart }),
      ),
    );
  }

  function shareKey() {
    return JSON.stringify([state.model, state.roof, state.palette, [...state.upgrades].sort()]);
  }

  function shareLinks() {
    const url = location.href;
    const caption = config.share.caption;
    return [
      ["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`],
      ["LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`],
      ["X", `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}&url=${encodeURIComponent(url)}`],
    ];
  }

  function followLinks() {
    const names = { instagram: "Instagram", youtube: "YouTube", facebook: "Facebook", linkedin: "LinkedIn" };
    return Object.entries(config.share.links || {})
      .filter(([, href]) => Boolean(href))
      .map(([key, href]) => [names[key] || key, href]);
  }

  function shareBlock() {
    const block = h(
      "section",
      { class: "share", "aria-labelledby": "share-title" },
      h("h3", { class: "share-title", id: "share-title", text: "Share your design" }),
      h("p", {
        class: "lead",
        text: `Show your NOOK on social media and tag us ${config.share.handle}. Your design card carries the NOOK Pods logo, our website and our social links.`,
      }),
      h("div", {
        class: "share-preview",
        id: "share-preview",
        oncontextmenu: (event) => event.preventDefault(),
      }),
      h("div", { class: "share-actions", id: "share-actions" }),
    );
    window.setTimeout(() => {
      updateShare();
      prepareShare();
    }, 0);
    return block;
  }

  function updateShare() {
    const preview = byId("share-preview");
    const actions = byId("share-actions");
    if (!preview || !actions) {
      return;
    }
    const ready = share.canvas && share.key === shareKey();
    if (ready) {
      if (preview.firstChild !== share.canvas) {
        preview.replaceChildren(share.canvas);
      }
    } else if (!preview.querySelector(".share-wait")) {
      preview.replaceChildren(h("p", { class: "share-wait", text: "Preparing your design card" }));
    }
    const nativeShare = Boolean(
      ready && share.file && navigator.canShare && navigator.canShare({ files: [share.file] }),
    );
    const parts = [
      nativeShare
        ? h(
            "button",
            { class: "send-button share-button", type: "button", onclick: shareNatively },
            "Share my design",
            h("span", { class: "send-arrow", html: ARROW }),
          )
        : null,
      h(
        "p",
        { class: "share-row" },
        h("span", { class: "share-label", text: nativeShare ? "Or share a link:" : "Share a link:" }),
        shareLinks().map(([name, href]) =>
          h("a", { class: "link-button", href, target: "_blank", rel: "noopener noreferrer", text: name }),
        ),
        h("button", {
          class: "link-button",
          type: "button",
          text: "Copy link and caption",
          onclick: copyCaption,
        }),
      ),
      h(
        "p",
        { class: "share-row" },
        h("span", { class: "share-label", text: "Follow NOOK:" }),
        followLinks().map(([name, href]) =>
          h("a", { class: "link-button", href, target: "_blank", rel: "noopener noreferrer", text: name }),
        ),
      ),
      share.message ? h("p", { class: "note", role: "status", text: share.message }) : null,
    ];
    actions.replaceChildren(...parts.filter(Boolean));
  }

  async function prepareShare() {
    const key = shareKey();
    if (share.key === key && (share.canvas || share.token)) {
      updateShare();
      return;
    }
    const token = {};
    share.token = token;
    share.key = key;
    share.canvas = null;
    share.file = null;
    try {
      const canvas = await composeShareCard();
      if (share.token !== token) {
        return;
      }
      canvas.classList.add("share-canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", `Design card: ${describe(state)}`);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      share.canvas = canvas;
      share.file = blob
        ? new File([blob], `NOOK-The-${currentModel().name.replace(/\s+/g, "-")}-design.jpg`, { type: "image/jpeg" })
        : null;
    } catch (error) {
      share.message = "Your design card could not be prepared just now.";
    } finally {
      if (share.token === token) {
        share.token = null;
      }
    }
    updateShare();
  }

  async function composeShareCard() {
    const model = currentModel();
    const layers = resolveStack(state);
    const images = await Promise.all(layers.map((layer) => loadImage(layerUrl(layer.name, true)).catch(() => null)));
    const logo = await loadImage("assets/brand/nook-pods-logo-white.svg").catch(() => null);
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    const sceneHeight = SHARE_HEIGHT - SHARE_BAND;
    const canvas = document.createElement("canvas");
    canvas.width = SHARE_WIDTH;
    canvas.height = SHARE_HEIGHT;
    const context = canvas.getContext("2d");
    context.fillStyle = STAGE_BACKGROUND;
    context.fillRect(0, 0, SHARE_WIDTH, sceneHeight);
    const crop = cropFor(
      unionBounds(layers),
      model.imageWidth,
      model.imageHeight,
      FRAME_PADDING,
      SHARE_WIDTH / sceneHeight,
    );
    for (const image of images.filter(Boolean)) {
      const scaleX = image.naturalWidth / model.imageWidth;
      const scaleY = image.naturalHeight / model.imageHeight;
      context.drawImage(
        image,
        crop.x * scaleX,
        crop.y * scaleY,
        crop.width * scaleX,
        crop.height * scaleY,
        0,
        0,
        SHARE_WIDTH,
        sceneHeight,
      );
    }
    context.fillStyle = "#151515";
    context.fillRect(0, sceneHeight, SHARE_WIDTH, SHARE_BAND);
    if (logo) {
      const logoHeight = 84;
      const logoWidth = (logoHeight * logo.naturalWidth) / logo.naturalHeight;
      context.drawImage(logo, SHARE_MARGIN, sceneHeight + (SHARE_BAND - logoHeight) / 2, logoWidth, logoHeight);
    }
    context.textAlign = "right";
    context.textBaseline = "alphabetic";
    const right = SHARE_WIDTH - SHARE_MARGIN;
    context.fillStyle = "#ffffff";
    context.font = `500 44px ${FONT_STACK}`;
    context.fillText(config.share.website, right, sceneHeight + 92);
    context.fillStyle = "#c9c5be";
    context.font = `400 26px ${FONT_STACK}`;
    context.fillText(`${config.share.handle} on Instagram and YouTube`, right, sceneHeight + 136);
    context.fillStyle = "#9a968f";
    context.font = `500 20px ${FONT_STACK}`;
    context.fillText(designLine().toUpperCase(), right, sceneHeight + 176);
    return canvas;
  }

  async function shareNatively() {
    if (!share.file) {
      return;
    }
    try {
      await navigator.share({
        files: [share.file],
        title: "My NOOK design",
        text: `${config.share.caption} ${location.href}`,
      });
    } catch (error) {
      if (error.name !== "AbortError") {
        share.message = "Sharing is not available here. Use a link below instead.";
        updateShare();
      }
    }
  }

  function copyCaption(event) {
    const button = event.currentTarget;
    navigator.clipboard
      .writeText(`${config.share.caption} ${location.href}`)
      .then(() => {
        button.textContent = "Link and caption copied";
      })
      .catch(() => {
        button.textContent = "Copy failed";
      });
  }

  function validate() {
    const customer = state.customer;
    const errors = {};
    for (const definition of config.detailFields) {
      const value = String(customer[definition.id] || "").trim();
      if (definition.required && !value) {
        errors[definition.id] =
          definition.type === "select"
            ? "Please choose an option."
            : `Please enter your ${definition.label.toLowerCase()}.`;
      }
    }
    if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email.trim())) {
      errors.email = "Please enter a valid email address.";
    }
    if (customer.phone && customer.phone.replace(/\D/g, "").length < 8) {
      errors.phone = "Please enter a phone number we can reach you on.";
    }
    state.errors = errors;
    return Object.keys(errors).length === 0;
  }

  function cropFor(bounds, sourceWidth, sourceHeight, padding = FRAME_PADDING, aspect = sourceWidth / sourceHeight) {
    if (!bounds) {
      return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    }
    let width = (bounds[2] - bounds[0] + 2 * padding) * sourceWidth;
    let height = (bounds[3] - bounds[1] + 2 * padding) * sourceHeight;
    if (width / height > aspect) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
    if (width > sourceWidth) {
      width = sourceWidth;
      height = width / aspect;
    }
    if (height > sourceHeight) {
      height = sourceHeight;
      width = height * aspect;
    }
    const centreX = ((bounds[0] + bounds[2]) / 2) * sourceWidth;
    const centreY = ((bounds[1] + bounds[3]) / 2) * sourceHeight;
    return {
      x: Math.min(Math.max(centreX - width / 2, 0), sourceWidth - width),
      y: Math.min(Math.max(centreY - height / 2, 0), sourceHeight - height),
      width,
      height,
    };
  }

  async function composeImage(width) {
    const layers = resolveStack(state);
    const images = await Promise.all(layers.map((layer) => loadImage(layerUrl(layer.name, true)).catch(() => null)));
    const model = currentModel();
    const crop = cropFor(unionBounds(layers), model.imageWidth, model.imageHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((width * crop.height) / crop.width);
    const context = canvas.getContext("2d");
    context.fillStyle = STAGE_BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const image of images.filter(Boolean)) {
      context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL("image/jpeg", 0.88);
  }

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  }

  function emailHtml(rows, customer, summary) {
    const tableRows = (pairs) =>
      pairs
        .map(
          ([term, value]) =>
            `<tr><td style="padding:6px 16px 6px 0;color:#6e6c69">${escapeHtml(term)}</td>` +
            `<td style="padding:6px 0;text-align:right">${escapeHtml(value)}</td></tr>`,
        )
        .join("");
    const priceRows = [...summary.included, ...summary.optional].map((line) => [
      line.title,
      line.display ?? formatPrice(line.value),
    ]);
    priceRows.push(["Your New Home Estimate", formatPrice(summary.total)]);
    return (
      '<div style="font-family:Arial,Helvetica,sans-serif;color:#141414;max-width:640px">' +
      '<h1 style="font-weight:400;font-size:24px">Your NOOK design</h1>' +
      `<p>Hi ${escapeHtml(customer.name)}, here is the design you built in the NOOK configurator.</p>` +
      `<table style="border-collapse:collapse;font-size:14px">${tableRows(rows)}</table>` +
      '<h2 style="font-weight:400;font-size:18px;margin-top:24px">Instant estimate</h2>' +
      `<table style="border-collapse:collapse;font-size:14px">${tableRows(priceRows)}</table>` +
      `<p style="font-size:12px;color:#6e6c69">Estimates only. ${escapeHtml(gstNote())} Subject to full specifications. Terms and conditions apply.</p>` +
      "</div>"
    );
  }

  function buildPayload(image) {
    const summary = pricing();
    const rows = summaryRows();
    const customer = { ...state.customer };
    return {
      submittedAt: new Date().toISOString(),
      customer,
      configuration: {
        model: state.model,
        roof: state.roof,
        tier: state.tier,
        palette: state.palette,
        cladding: claddingFor(state.upgrades),
        upgrades: [...state.upgrades],
      },
      pricing: {
        currency: config.currency,
        pricesIncludeGst: Boolean(config.pricesIncludeGst),
        lines: [...summary.included, ...summary.optional].map((line) => ({
          id: line.id,
          label: line.title,
          value: line.value,
          display: line.display,
        })),
        estimatedTotal: summary.total,
        transportPoa: summary.hasPoa,
      },
      designUrl: location.href,
      imageDataUrl: image,
      emailHtml: emailHtml(rows, customer, summary),
    };
  }

  async function submit() {
    if (state.sending) {
      return;
    }
    if (!validate()) {
      renderSteps({ keepScroll: true });
      document.querySelector('#steps [aria-invalid="true"]')?.focus();
      return;
    }
    state.sending = true;
    state.sendError = "";
    renderSteps({ keepScroll: true });
    try {
      const image = await composeImage(1600);
      const payload = buildPayload(image);
      if (config.submitEndpoint) {
        const response = await fetch(config.submitEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`Server replied ${response.status}`);
        }
      }
      state.submitted = true;
    } catch (error) {
      state.sendError = "Sorry, we could not send your design just now. Please try again in a moment.";
    } finally {
      state.sending = false;
      renderSteps({ keepScroll: false });
      byId("steps-panel").scrollTop = 0;
    }
  }

  function restart() {
    stopPlayback();
    state.model = defaultModelId();
    state.roof = "box";
    state.palette = "A";
    state.tier = availableTiers()[0].id;
    state.upgrades = new Set();
    state.submitted = false;
    state.sending = false;
    state.sendError = "";
    state.errors = {};
    share.message = "";
    enforceRules();
    render();
    goToStep(0, { scroll: false });
    byId("configurator").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  }

  function select(key, value) {
    stopPlayback();
    state[key] = value;
    enforceRules();
    render();
  }

  function selectModel(id) {
    const model = findModel(id);
    if (!model || !isAvailable(model) || id === state.model) {
      return;
    }
    stopPlayback();
    const wasRequired = config.upgrades.filter(isRequired).map((item) => item.id);
    state.model = id;
    for (const upgrade of wasRequired) {
      if (!isRequired(findUpgrade(upgrade))) {
        state.upgrades.delete(upgrade);
      }
    }
    enforceRules();
    render();
  }

  const BUILDERS = {
    design: designStep,
    roof: roofStep,
    specification: specificationStep,
    palette: paletteStep,
    upgrades: upgradesStep,
    estimate: estimateStep,
    details: detailsStep,
  };

  function stepNavigation() {
    const steps = config.steps;
    const first = state.step === 0;
    const last = state.step === steps.length - 1;
    return h(
      "div",
      { class: "step-nav" },
      first
        ? h("span")
        : h(
            "button",
            { class: "back-button", type: "button", onclick: () => goToStep(state.step - 1) },
            h("span", { class: "back-arrow", html: CHEVRON }),
            "Back",
          ),
      last
        ? null
        : h(
            "button",
            { class: "next-button", type: "button", onclick: () => goToStep(state.step + 1) },
            `Next: ${steps[state.step + 1].label}`,
            h("span", { class: "next-arrow", html: ARROW }),
          ),
    );
  }

  function renderSteps(options = {}) {
    const step = config.steps[state.step];
    const container = byId("steps");
    const panel = byId("steps-panel");
    const focusedKey = document.activeElement?.dataset?.key;
    const scroll = panel.scrollTop;
    const body = byId("step-body");
    if (
      body &&
      body.dataset.step === step.id &&
      step.id === "details" &&
      body.contains(document.activeElement) &&
      !state.sending &&
      !state.submitted &&
      !Object.keys(state.errors).length &&
      options.force !== true
    ) {
      return;
    }
    container.replaceChildren(
      h(
        "section",
        { class: "step", "aria-labelledby": "step-title" },
        h(
          "div",
          { class: "step-head" },
          h("span", { class: "step-number", "aria-hidden": "true", text: String(state.step + 1) }),
          h("h2", { class: "step-title", id: "step-title", tabindex: "-1", text: step.title }),
        ),
        h(
          "div",
          { class: "step-body", id: "step-body", "data-step": step.id },
          [BUILDERS[step.id]()].flat(Infinity).filter(Boolean),
        ),
        stepNavigation(),
      ),
    );
    if (options.keepScroll) {
      panel.scrollTop = scroll;
    }
    if (focusedKey) {
      document.querySelector(`[data-key="${focusedKey}"]`)?.focus({ preventScroll: true });
    }
  }

  function render() {
    renderSteps({ keepScroll: true, force: true });
    renderProgress();
    if (!playback) {
      renderStage(state);
    }
    renderGallery();
    if (!state.submitted) {
      writeHash();
    }
  }

  function sequenceView(frame) {
    return { roof: frame.roof, palette: frame.palette, upgrades: new Set(frame.upgrades) };
  }

  async function playSequence() {
    if (playback) {
      stopPlayback();
      return;
    }
    const button = byId("stage-play");
    const token = {};
    playback = token;
    button.textContent = "Preparing";
    const names = new Set(
      config.buildSequence.flatMap((frame) => resolveStack(sequenceView(frame)).map((layer) => layer.name)),
    );
    await Promise.all([...names].map((name) => loadImage(layerUrl(name)).catch(() => null)));
    if (playback !== token) {
      return;
    }
    button.textContent = "Stop";
    for (const frame of config.buildSequence) {
      if (playback !== token) {
        return;
      }
      renderStage(sequenceView(frame), frame.caption);
      await new Promise((resolve) => window.setTimeout(resolve, frame.hold || FRAME_MS));
    }
    await new Promise((resolve) => window.setTimeout(resolve, FRAME_MS));
    if (playback === token) {
      stopPlayback();
    }
  }

  function stopPlayback() {
    if (!playback) {
      return;
    }
    playback = null;
    byId("stage-play").textContent = "Watch it build";
    renderStage(state);
  }

  function bindChrome() {
    byId("stage-play").addEventListener("click", playSequence);
    byId("start-new").addEventListener("click", restart);
    byId("next-top").addEventListener("click", () => goToStep(state.step + 1));
    byId("stage").addEventListener("contextmenu", (event) => event.preventDefault());
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => frameStage(framedBounds, false), 160);
    });
  }

  async function loadJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`);
    }
    return response.json();
  }

  async function loadManifests() {
    await Promise.all(
      config.models
        .filter((model) => model.layers)
        .map(async (model) => {
          try {
            manifests.set(model.id, await loadJson(`${model.layers}manifest.json`));
          } catch (error) {
            manifests.set(model.id, null);
          }
        }),
    );
  }

  async function init() {
    try {
      config = await loadJson("data/configurator.json");
    } catch (error) {
      byId("steps").textContent = "The configurator could not load its data. Please refresh the page.";
      return;
    }
    money = new Intl.NumberFormat(config.locale, {
      style: "currency",
      currency: config.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    await loadManifests();
    state.model = defaultModelId();
    if (!state.model) {
      byId("steps").textContent = "The configurator could not load its designs. Please refresh the page.";
      return;
    }
    const stageWidth = byId("stage").clientWidth || window.innerWidth;
    const deviceWidth = stageWidth * (window.devicePixelRatio || 1);
    layerSuffix = deviceWidth > 1400 ? "" : "-1280";
    readHash();
    enforceRules();
    bindChrome();
    bindGallery();
    render();
  }

  init();
})();
