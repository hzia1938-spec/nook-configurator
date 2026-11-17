(() => {
  "use strict";

  const FADE_MS = 320;
  const FRAME_MS = 1500;
  const FRAME_PADDING = 0.07;
  const SPIN_PADDING = 0.04;
  const MAX_ZOOM = 1.75;
  const SPIN_INTRO_MS = 70;
  const STAGE_BACKGROUND = "#ffffff";
  const CHEVRON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const ARROW =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  const state = {
    model: "pavilion",
    roof: "box",
    tier: "freedom",
    palette: "A",
    upgrades: new Set(),
    customer: {},
    errors: {},
    submitted: false,
    sending: false,
    sendError: "",
    summaryImage: "",
    section: 0,
  };

  const spin = {
    active: false,
    angle: 0,
    manifest: null,
    suffix: "",
    key: "",
    frames: [],
    token: null,
    intro: null,
    drag: null,
  };

  let config = null;
  let money = null;
  let layerSuffix = "";
  let playback = null;
  let lastFocus = null;
  let layerBounds = {};
  let framedBounds = null;
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

  const currentModel = () => config.models.find((item) => item.id === state.model);
  const collectionOf = (model) => config.collections.find((item) => item.id === model.collection);
  const findRoof = (id) => config.roofs.find((item) => item.id === id);
  const findTier = (id) => config.tiers.find((item) => item.id === id);
  const findPalette = (id) => config.palettes.find((item) => item.id === id);
  const findUpgrade = (id) => config.upgrades.find((item) => item.id === id);
  const availableTiers = () => collectionOf(currentModel()).tiers.map(findTier);
  const formatPrice = (value) => money.format(value);

  function isRequired(item) {
    return item.requiredOver !== undefined && currentModel().floorArea > item.requiredOver;
  }

  function enforceRules() {
    if (!availableTiers().some((tier) => tier.id === state.tier)) {
      state.tier = availableTiers()[0].id;
    }
    for (const item of config.upgrades) {
      if (isRequired(item)) {
        state.upgrades.add(item.id);
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

  function tierTitle(tier) {
    return `${tier.name.toUpperCase()} - ${tier.label}`;
  }

  function modelTitle(model) {
    return `The ${model.name} | ${model.floorArea}`;
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
        summary: roof.summary,
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
    enforceRules();
  }

  function writeHash() {
    const params = new URLSearchParams({ roof: state.roof, tier: state.tier, palette: state.palette });
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
    return (
      (entry.when || []).every((id) => upgrades.has(id)) &&
      !(entry.unless || []).some((id) => upgrades.has(id))
    );
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
      (union, layer) => (layer.slot === "shadow" ? union : mergeBounds(union, layerBounds[layer.name])),
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
    const wanted = new Map(layers.map((layer) => [layer.slot, layer.name]));
    frameStage(unionBounds(layers));
    let pending = 0;
    slotOrder().forEach((slot, index) => {
      const name = wanted.get(slot);
      const current = slots.get(slot);
      if (current && current.name === name) {
        return;
      }
      if (!name) {
        if (current) {
          container.querySelectorAll(`img[data-slot="${slot}"]`).forEach(retire);
          slots.delete(slot);
        }
        return;
      }
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.dataset.slot = slot;
      image.style.zIndex = String(index + 1);
      const record = { name, image };
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
      image.src = layerUrl(name);
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
      loadImage(url).catch(() => {}).finally(next);
    };
    next();
    next();
  }

  function prefetchForSection(index) {
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

  function renderInteriors() {
    const strip = byId("interior-strip");
    const items = config.upgrades.filter((item) => item.interior && state.upgrades.has(item.id));
    strip.hidden = items.length === 0;
    strip.replaceChildren(
      ...items.map((item) =>
        h(
          "button",
          {
            class: "interior-card",
            type: "button",
            "aria-label": `View ${item.interiorCaption.toLowerCase()}`,
            onclick: (event) => openLightbox(interiorMedia(item), item.interiorCaption, event.currentTarget),
          },
          item.interior === "smart"
            ? h("span", { class: "smart-thumb", "aria-hidden": "true", text: "Panel" })
            : h("img", { src: interiorUrl(item), alt: "", loading: "lazy", width: "96", height: "60" }),
          h(
            "span",
            {},
            h("span", { class: "interior-eyebrow", text: "Inside" }),
            h("span", { text: item.interiorCaption }),
          ),
        ),
      ),
    );
  }

  function interiorUrl(item) {
    return `${currentModel().interiors}${item.interior}_${state.palette}.jpg`;
  }

  function interiorMedia(item) {
    return item.interior === "smart"
      ? smartPanel()
      : h("img", { src: interiorUrl(item), alt: item.interiorCaption });
  }

  function smartPanel() {
    const tile = (title, detail, value, on) =>
      h(
        "div",
        { class: on ? "smart-tile is-on" : "smart-tile" },
        h("span", { text: title }),
        h("span", { text: detail }),
        h("strong", { text: value }),
      );
    return h(
      "div",
      { class: "smart-panel" },
      h("div", { class: "smart-head" }, h("strong", { text: "NOOK Home" }), h("span", { text: "Evening" })),
      h(
        "div",
        { class: "smart-grid" },
        tile("Lights", "Lounge scene", "60%", true),
        tile("Climate", "Heat pump", "21 C", false),
        tile("Security", "Doors locked", "Armed", false),
        tile("Energy", "Solar now", "3.2 kW", true),
        tile("Battery", "Stored", "84%", false),
        tile("Water", "Tank level", "72%", false),
      ),
    );
  }

  function renderGallery() {
    const model = currentModel();
    const grid = byId("gallery-grid");
    byId("gallery").hidden = !model.gallery;
    if (!model.gallery) {
      grid.replaceChildren();
      return;
    }
    const palette = findPalette(state.palette);
    grid.replaceChildren(
      ...config.gallery.map((item) => {
        const base = `${model.gallery}${state.palette}/${item.file}`;
        const caption = `The ${model.name} in ${palette.name}: ${item.caption.toLowerCase()}`;
        return h(
          "li",
          {},
          h(
            "button",
            {
              class: "gallery-item",
              type: "button",
              "aria-label": `Enlarge ${caption}`,
              onclick: (event) =>
                openLightbox(h("img", { src: `${base}.jpg`, alt: caption }), caption, event.currentTarget),
            },
            h("img", { src: `${base}-thumb.jpg`, alt: "", loading: "lazy", width: "480", height: "270" }),
          ),
        );
      }),
    );
  }

  function openLightbox(media, caption, trigger) {
    lastFocus = trigger;
    byId("lightbox-media").replaceChildren(media);
    byId("lightbox-caption").textContent = caption;
    byId("lightbox").hidden = false;
    byId("lightbox-close").focus();
  }

  function closeLightbox() {
    byId("lightbox").hidden = true;
    if (lastFocus) {
      lastFocus.focus();
    }
  }

  function renderProgress() {
    const steps = config.steps;
    byId("progress").replaceChildren(
      h(
        "p",
        { class: "progress-label" },
        h("span", { text: `Step ${state.section + 1} of ${steps.length}` }),
        h("span", { text: steps[state.section].label }),
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
              class: index === state.section ? "is-current" : "",
              "aria-label": `Step ${index + 1}: ${step.label}`,
              "aria-current": index === state.section ? "step" : null,
              onclick: () => scrollToSection(index),
            }),
          ),
        ),
      ),
    );
  }

  function scrollToSection(index) {
    const section = byId(`step-${config.steps[index].id}`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    section.querySelector(".step-title")?.focus({ preventScroll: true });
  }

  function choice({ key, pressed, disabled, onclick, title, after, summary, extra, price, label }) {
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: "choice",
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
    return [h("strong", { text: main }), rest ? ` - ${rest}` : null];
  }

  function designStep() {
    const blocks = config.collections.map((collection) => {
      const models = config.models.filter((model) => model.collection === collection.id);
      return [
        h("h3", { class: "group-title", text: collection.name }),
        h(
          "ul",
          { class: "choice-grid", style: `--rows:${Math.ceil(models.length / 2)}` },
          models.map((model) =>
            choice({
              key: `model:${model.id}`,
              pressed: model.id === state.model,
              disabled: !model.available,
              label: model.available ? null : `The ${model.name}, ${model.floorArea} square metres, coming soon`,
              onclick: () => {
                state.model = model.id;
                enforceRules();
                render();
              },
              title: ["The ", h("strong", { text: model.name }), ` | ${model.floorArea}`],
            }),
          ),
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
        text: "The Pavilion is live in this test build. The other designs join as they are rendered.",
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
            summary: roof.summary,
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
            title: h("strong", { text: palette.name.toUpperCase() }),
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
            title: h("strong", { text: item.name }),
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
        text: "Select from our range of premium upgrades and customise your new home to your lifestyle & budget (estimates only).",
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
      summary.hasPoa
        ? h("p", { class: "note", text: "Plus transport & delivery, priced on application." })
        : null,
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
      return confirmation();
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
      ["Your New Home Estimate", formatPrice(summary.total) + (summary.hasPoa ? " plus transport (POA)" : "")],
    ];
  }

  function confirmation() {
    const testMode = !config.submitEndpoint;
    return [
      testMode
        ? h("p", {
            class: "banner",
            role: "status",
            text: "Test build: no email was sent. On the live site your design goes to you and to the NOOK team.",
          })
        : null,
      h("p", { class: "confirm-title", text: "Your design is on its way to your inbox!" }),
      h("p", { class: "lead", text: "We'll be in touch soon to chat about bringing it to life." }),
      state.summaryImage
        ? h("img", { class: "summary-image", src: state.summaryImage, alt: describe(state) })
        : null,
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
        state.summaryImage
          ? h("a", {
              class: "link-button",
              href: state.summaryImage,
              download: `NOOK-The-${currentModel().name.replace(/\s+/g, "-")}-design.jpg`,
              text: "Download image",
            })
          : null,
        h("button", { class: "link-button", type: "button", text: "Print or save as PDF", onclick: () => window.print() }),
        h("button", { class: "link-button", type: "button", text: "Copy design link", onclick: copyLink }),
        h("button", { class: "link-button", type: "button", text: "Start a new design", onclick: restart }),
      ),
    ];
  }

  function copyLink(event) {
    const button = event.currentTarget;
    navigator.clipboard
      .writeText(location.href)
      .then(() => {
        button.textContent = "Link copied";
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
          definition.type === "select" ? "Please choose an option." : `Please enter your ${definition.label.toLowerCase()}.`;
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
    const images = await Promise.all(
      layers.map((layer) => loadImage(layerUrl(layer.name, true)).catch(() => null)),
    );
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
      '<p style="font-size:12px;color:#6e6c69">Estimates only, in NZD. Subject to full specifications. Terms and conditions apply.</p>' +
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
      renderSections();
      document.querySelector('#steps [aria-invalid="true"]')?.focus();
      return;
    }
    state.sending = true;
    state.sendError = "";
    renderSections();
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
      state.summaryImage = image;
      state.submitted = true;
    } catch (error) {
      state.sendError = "Sorry, we could not send your design just now. Please try again in a moment.";
    } finally {
      state.sending = false;
      renderSections();
      byId("step-details").scrollIntoView({ block: "start" });
    }
  }

  function restart() {
    state.roof = "box";
    state.palette = "A";
    state.tier = availableTiers()[0].id;
    state.upgrades = new Set();
    state.submitted = false;
    state.summaryImage = "";
    state.errors = {};
    enforceRules();
    render();
    scrollToSection(0);
  }

  function select(key, value) {
    stopPlayback();
    state[key] = value;
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

  function buildSections() {
    byId("steps").replaceChildren(
      ...config.steps.map((step, index) =>
        h(
          "section",
          { class: "step", id: `step-${step.id}`, "aria-labelledby": `step-${step.id}-title` },
          h(
            "div",
            { class: "step-head" },
            h("span", { class: "step-number", "aria-hidden": "true", text: String(index + 1) }),
            h("h2", { class: "step-title", id: `step-${step.id}-title`, tabindex: "-1", text: step.title }),
          ),
          h("div", { class: "step-body", id: `step-${step.id}-body` }),
        ),
      ),
    );
  }

  function renderSections() {
    const focusedKey = document.activeElement?.dataset?.key;
    for (const step of config.steps) {
      const body = byId(`step-${step.id}-body`);
      if (step.id === "details" && body.contains(document.activeElement) && !state.sending && !state.submitted) {
        if (!Object.keys(state.errors).length) {
          continue;
        }
      }
      body.replaceChildren(...[BUILDERS[step.id]()].flat(Infinity).filter(Boolean));
    }
    if (focusedKey) {
      document.querySelector(`[data-key="${focusedKey}"]`)?.focus({ preventScroll: true });
    }
  }

  function render() {
    renderSections();
    renderProgress();
    if (!playback) {
      renderStage(state);
    }
    renderInteriors();
    renderGallery();
    const ready = spinReady(state);
    byId("spin-toggle").hidden = !ready;
    if (spin.active && !ready) {
      toggleSpin(false);
    } else if (spin.active) {
      buildSpin();
    }
    if (!state.submitted) {
      writeHash();
    }
  }

  function watchSections() {
    const sections = config.steps.map((step) => byId(`step-${step.id}`));
    const visible = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible.set(entry.target, entry.isIntersecting);
        }
        const index = sections.findIndex((section) => visible.get(section));
        if (index >= 0 && index !== state.section) {
          state.section = index;
          renderProgress();
          prefetchForSection(index);
        }
      },
      { rootMargin: "-40% 0px -50% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
  }

  function sequenceView(frame) {
    return { roof: frame.roof, palette: frame.palette, upgrades: new Set(frame.upgrades) };
  }

  async function playSequence() {
    if (playback) {
      stopPlayback();
      return;
    }
    if (spin.active) {
      toggleSpin(false);
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

  const pad = (value) => String(value).padStart(2, "0");

  function spinLayers(view, angle) {
    const azimuth = ((config.spin.azimuth + (360 * angle) / config.spin.count) * Math.PI) / 180;
    const fixed = [];
    const free = [];
    for (const entry of config.spin.stack) {
      if (!matches(entry, view.upgrades)) {
        continue;
      }
      const layer = { slot: entry.slot, name: fill(entry.src, view) };
      if (entry.at) {
        layer.depth = entry.at[0] * Math.sin(azimuth) - entry.at[1] * Math.cos(azimuth);
        free.push(layer);
      } else {
        fixed.push(layer);
      }
    }
    free.sort((a, b) => a.depth - b.depth);
    return fixed.concat(free);
  }

  function spinReady(view) {
    if (!spin.manifest || !currentModel().spin) {
      return false;
    }
    const missing = new Set(spin.manifest.missing || []);
    for (let angle = 0; angle < config.spin.count; angle += 1) {
      for (const layer of spinLayers(view, angle)) {
        if (!spin.manifest.layers[layer.name] || missing.has(`${layer.name}@${pad(angle)}`)) {
          return false;
        }
      }
    }
    return true;
  }

  function spinUrl(name, angle) {
    return `${currentModel().spin}${pad(angle)}/${name}${spin.suffix}.webp`;
  }

  function spinCrop(names, aspect) {
    let union = null;
    for (const name of names) {
      for (const bounds of spin.manifest.layers[name] || []) {
        union = mergeBounds(union, bounds);
      }
    }
    return cropFor(union, config.spin.imageWidth, config.spin.imageHeight, SPIN_PADDING, aspect);
  }

  async function fetchBitmap(url) {
    try {
      const response = await fetch(url);
      return response.ok ? await createImageBitmap(await response.blob()) : null;
    } catch (error) {
      return null;
    }
  }

  function angleOrder(start, count) {
    const order = [start];
    for (let step = 1; order.length < count; step += 1) {
      for (const angle of [start + step, start - step]) {
        const wrapped = ((angle % count) + count) % count;
        if (!order.includes(wrapped)) {
          order.push(wrapped);
        }
      }
    }
    return order;
  }

  function showSpinFrame() {
    const count = config.spin.count;
    let url = spin.frames[spin.angle];
    for (let offset = 1; !url && offset < count; offset += 1) {
      url = spin.frames[(spin.angle + offset) % count] || spin.frames[(spin.angle - offset + count) % count];
    }
    if (url) {
      const image = byId("spin-image");
      if (image.getAttribute("src") !== url) {
        image.src = url;
      }
    }
  }

  async function buildSpin() {
    const count = config.spin.count;
    const view = { roof: state.roof, palette: state.palette, upgrades: new Set(state.upgrades) };
    const perAngle = Array.from({ length: count }, (_, angle) => spinLayers(view, angle));
    const stage = byId("stage");
    const aspect = stage.clientWidth / stage.clientHeight;
    const key = `${JSON.stringify(perAngle.map((layers) => layers.map((layer) => layer.name)))}|${aspect.toFixed(3)}`;
    if (key === spin.key) {
      showSpinFrame();
      return;
    }
    const token = {};
    spin.token = token;
    cancelIntro();
    const names = [...new Set(perAngle.flat().filter((layer) => layer.slot !== "shadow").map((layer) => layer.name))];
    const crop = spinCrop(names, aspect);
    const scale = spin.suffix ? 0.5 : 1;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(Math.min(crop.width * scale, stage.clientWidth * ratio));
    const height = Math.round(width / aspect);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const frames = new Array(count).fill(null);
    const order = angleOrder(spin.angle, count);
    const fetches = new Map();
    const request = (angle) => {
      if (!fetches.has(angle)) {
        fetches.set(angle, Promise.all(perAngle[angle].map((layer) => fetchBitmap(spinUrl(layer.name, angle)))));
      }
      return fetches.get(angle);
    };
    let adopted = false;
    for (let index = 0; index < order.length; index += 1) {
      const angle = order[index];
      order.slice(index + 1, index + 3).forEach(request);
      const bitmaps = await request(angle);
      fetches.delete(angle);
      if (spin.token !== token) {
        bitmaps.forEach((bitmap) => bitmap?.close());
        if (spin.frames !== frames) {
          frames.forEach((url) => url && URL.revokeObjectURL(url));
        }
        return;
      }
      context.fillStyle = STAGE_BACKGROUND;
      context.fillRect(0, 0, width, height);
      for (const bitmap of bitmaps) {
        if (bitmap) {
          context.drawImage(
            bitmap,
            crop.x * scale,
            crop.y * scale,
            crop.width * scale,
            crop.height * scale,
            0,
            0,
            width,
            height,
          );
          bitmap.close();
        }
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      frames[angle] = URL.createObjectURL(blob);
      if (!adopted) {
        adopted = true;
        spin.frames.forEach((url) => url && URL.revokeObjectURL(url));
        spin.frames = frames;
        byId("spin-view").hidden = false;
        byId("stage-layers").classList.add("is-hidden");
      }
      showSpinFrame();
      setStatus(index + 1 < count ? `Loading 360 view ${index + 1} of ${count}` : "");
    }
    if (spin.token === token) {
      spin.key = key;
      playIntro();
    }
  }

  function setSpinAngle(angle) {
    const count = config.spin.count;
    spin.angle = ((angle % count) + count) % count;
    showSpinFrame();
  }

  function cancelIntro() {
    if (spin.intro) {
      window.clearInterval(spin.intro);
      spin.intro = null;
    }
  }

  function playIntro() {
    if (spin.played || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    spin.played = true;
    let steps = 0;
    spin.intro = window.setInterval(() => {
      steps += 1;
      setSpinAngle(spin.angle + 1);
      if (steps >= config.spin.count) {
        cancelIntro();
      }
    }, SPIN_INTRO_MS);
  }

  function toggleSpin(force) {
    const active = force ?? !spin.active;
    spin.active = active;
    const button = byId("spin-toggle");
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.textContent = active ? "Exit 360 view" : "360 view";
    byId("spin-controls").hidden = !active;
    byId("stage").classList.toggle("is-spinning", active);
    if (active) {
      stopPlayback();
      byId("stage").setAttribute("tabindex", "0");
      buildSpin();
    } else {
      spin.token = null;
      spin.key = "";
      cancelIntro();
      setStatus("");
      byId("spin-view").hidden = true;
      byId("stage-layers").classList.remove("is-hidden");
      byId("stage").removeAttribute("tabindex");
    }
  }

  function bindSpin() {
    const stage = byId("stage");
    byId("spin-toggle").addEventListener("click", () => toggleSpin());
    byId("spin-left").innerHTML = CHEVRON;
    byId("spin-right").innerHTML = CHEVRON;
    byId("spin-left").addEventListener("click", () => {
      cancelIntro();
      setSpinAngle(spin.angle + 1);
    });
    byId("spin-right").addEventListener("click", () => {
      cancelIntro();
      setSpinAngle(spin.angle - 1);
    });
    stage.addEventListener("pointerdown", (event) => {
      if (!spin.active || event.target.closest("button")) {
        return;
      }
      cancelIntro();
      spin.drag = { x: event.clientX, angle: spin.angle };
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener("pointermove", (event) => {
      if (!spin.drag) {
        return;
      }
      const stepWidth = Math.max(8, stage.clientWidth / 48);
      setSpinAngle(spin.drag.angle - Math.round((event.clientX - spin.drag.x) / stepWidth));
    });
    const release = () => {
      spin.drag = null;
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointercancel", release);
    stage.addEventListener("keydown", (event) => {
      if (!spin.active) {
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        cancelIntro();
        setSpinAngle(spin.angle + (event.key === "ArrowLeft" ? 1 : -1));
      }
    });
  }

  function bindChrome() {
    byId("stage-play").addEventListener("click", playSequence);
    byId("lightbox-close").addEventListener("click", closeLightbox);
    byId("lightbox").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) {
        closeLightbox();
      }
    });
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        frameStage(framedBounds, false);
        if (spin.active) {
          buildSpin();
        }
      }, 160);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !byId("lightbox").hidden) {
        closeLightbox();
      }
    });
  }

  async function loadJson(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`);
    }
    return response.json();
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
    const model = currentModel();
    try {
      const manifest = await loadJson(`${model.layers}manifest.json`);
      layerBounds = Object.fromEntries(
        Object.entries(manifest.layers).map(([name, entry]) => [name, entry.bounds]),
      );
    } catch (error) {
      layerBounds = {};
    }
    if (model.spin && config.spin) {
      try {
        spin.manifest = await loadJson(`${model.spin}manifest.json`);
      } catch (error) {
        spin.manifest = null;
      }
    }
    const stageWidth = byId("stage").clientWidth || window.innerWidth;
    const deviceWidth = stageWidth * (window.devicePixelRatio || 1);
    layerSuffix = deviceWidth > 1400 ? "" : "-1280";
    spin.suffix = deviceWidth > 1300 ? "" : "-1200";
    readHash();
    buildSections();
    bindChrome();
    bindSpin();
    render();
    watchSections();
  }

  init();
})();
