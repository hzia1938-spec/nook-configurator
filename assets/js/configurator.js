(() => {
  "use strict";

  const ROOF_ICONS = {
    box: '<path d="M6 13h44" stroke-width="3"/><path d="M8 13h40v21H8z"/>',
    mono: '<path d="M6 9l44 7" stroke-width="3"/><path d="M8 9.3l40 6.4V34H8z"/>',
    gable: '<path d="M5 19L28 5l23 14" stroke-width="3"/><path d="M8 17.2L28 5l20 12.2V34H8z"/>',
    tilt: '<path d="M6 15l30-9 14 6" stroke-width="3"/><path d="M8 14.4L36 6l12 5.1V34H8z"/><path d="M36 6l-6 28"/>',
  };
  const UPGRADE_GROUPS = [
    { title: "Energy and comfort", ids: ["solar", "ac", "fireplace", "smart"] },
    { title: "Exterior", ids: ["screens", "abodo", "aluminium"] },
    {
      title: "Site and services",
      ids: ["tank", "wastewater", "landscaping", "transport"],
    },
  ];
  const DETAIL_FIELDS = [
    { id: "name", label: "Full name", type: "text", autocomplete: "name" },
    { id: "email", label: "Email", type: "email", autocomplete: "email" },
    { id: "phone", label: "Phone", type: "tel", autocomplete: "tel" },
    {
      id: "location",
      label: "Build location",
      type: "text",
      autocomplete: "address-level2",
      placeholder: "Town or region",
    },
  ];
  const FADE_MS = 320;
  const FRAME_MS = 1500;
  const FRAME_PADDING = 0.07;
  const MAX_ZOOM = 1.75;

  const state = {
    step: 0,
    maxStep: 0,
    model: "pavilion",
    roof: "box",
    palette: "A",
    upgrades: new Set(),
    customer: {
      name: "",
      email: "",
      phone: "",
      location: "",
      notes: "",
      consent: false,
    },
    errors: {},
    submitted: false,
    sending: false,
    sendError: "",
    summaryImage: "",
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

  function svgIcon(markup) {
    const holder = document.createElement("span");
    holder.innerHTML = `<svg class="roof-icon" viewBox="0 0 56 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
    return holder.firstElementChild;
  }

  const currentModel = () => config.models.find((item) => item.id === state.model);
  const findRoof = (id) => config.roofs.find((item) => item.id === id);
  const findPalette = (id) => config.palettes.find((item) => item.id === id);
  const findUpgrade = (id) => config.upgrades.find((item) => item.id === id);

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
        return item.name.replace(/ cladding$/i, "");
      }
    }
    return "Standard vertical timber";
  }

  function roofPrice(roofId) {
    return findRoof(roofId).ratePerSqm * currentModel().floorArea;
  }

  function formatPrice(value) {
    return money.format(value);
  }

  function roofPriceLabel(roof) {
    if (roof.ratePerSqm === 0) {
      return { main: "Included", detail: "" };
    }
    return {
      main: `+${formatPrice(roofPrice(roof.id))}`,
      detail: `${formatPrice(roof.ratePerSqm)} per sq m`,
    };
  }

  function upgradePriceLabel(item) {
    return item.price === null ? item.priceLabel : `From ${formatPrice(item.price)}`;
  }

  function pricing() {
    const model = currentModel();
    const roof = findRoof(state.roof);
    const lines = [
      {
        label: `${model.name} base pod`,
        detail: `${model.range}, ${model.size}`,
        value: model.basePrice,
        display: model.basePrice === null ? "To be confirmed" : null,
      },
      {
        label: `${roof.name} roof`,
        detail:
          roof.ratePerSqm === 0
            ? null
            : `${formatPrice(roof.ratePerSqm)} per sq m x ${model.floorArea} sq m`,
        value: roofPrice(roof.id),
        display: roof.ratePerSqm === 0 ? "Included" : null,
      },
      {
        label: `${findPalette(state.palette).name} palette`,
        value: 0,
        display: "Included",
      },
    ];
    for (const item of config.upgrades) {
      if (state.upgrades.has(item.id)) {
        lines.push({
          label: item.name,
          value: item.price,
          display: item.price === null ? item.priceLabel : null,
        });
      }
    }
    const options = lines
      .slice(1)
      .reduce((sum, line) => sum + (typeof line.value === "number" ? line.value : 0), 0);
    const hasPoa = lines.slice(1).some((line) => line.value === null);
    const total = model.basePrice === null ? null : model.basePrice + options;
    return { lines, options, total, hasPoa, basePrice: model.basePrice };
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (findRoof(params.get("roof"))) {
      state.roof = params.get("roof");
    }
    if (findPalette(params.get("palette"))) {
      state.palette = params.get("palette");
    }
    const upgrades = (params.get("upgrades") || "").split(",").filter((id) => findUpgrade(id));
    state.upgrades = new Set();
    for (const id of upgrades) {
      toggleUpgrade(id, true);
    }
    const step = Number(params.get("step"));
    if (Number.isInteger(step) && step >= 0 && step <= 4) {
      state.step = step;
      state.maxStep = step;
    }
  }

  function writeHash() {
    const params = new URLSearchParams({
      roof: state.roof,
      palette: state.palette,
      step: String(Math.min(state.step, 4)),
    });
    if (state.upgrades.size) {
      params.set("upgrades", [...state.upgrades].join(","));
    }
    history.replaceState(null, "", `#${params.toString()}`);
  }

  function toggleUpgrade(id, force) {
    const item = findUpgrade(id);
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

  function layerUrl(name, full = false) {
    return `${currentModel().layers}${name}${full ? "" : layerSuffix}.webp`;
  }

  function resolveStack(view) {
    const values = {
      roof: view.roof,
      palette: view.palette,
      cladding: claddingFor(view.upgrades),
    };
    return config.stack
      .filter(
        (entry) =>
          (!entry.when || view.upgrades.has(entry.when)) &&
          (!entry.unless || !view.upgrades.has(entry.unless)),
      )
      .map((entry) => ({
        slot: entry.slot,
        name: entry.src.replace(/\{(\w+)\}/g, (match, key) => values[key]),
      }));
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

  function unionBounds(layers) {
    let union = null;
    for (const layer of layers) {
      const bounds = layer.slot === "shadow" ? null : layerBounds[layer.name];
      if (!bounds) {
        continue;
      }
      union = union
        ? [
            Math.min(union[0], bounds[0]),
            Math.min(union[1], bounds[1]),
            Math.max(union[2], bounds[2]),
            Math.max(union[3], bounds[3]),
          ]
        : [...bounds];
    }
    return union;
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
    config.stack.forEach((entry, index) => {
      const name = wanted.get(entry.slot);
      const current = slots.get(entry.slot);
      if (current && current.name === name) {
        return;
      }
      if (!name) {
        if (current) {
          container.querySelectorAll(`img[data-slot="${entry.slot}"]`).forEach(retire);
          slots.delete(entry.slot);
        }
        return;
      }
      const image = new Image();
      image.alt = "";
      image.decoding = "async";
      image.dataset.slot = entry.slot;
      image.style.zIndex = String(index + 1);
      const record = { name, image };
      slots.set(entry.slot, record);
      pending += 1;
      setStatus("Loading");
      image.onload = () => {
        pending -= 1;
        if (pending === 0) {
          setStatus("");
        }
        if (slots.get(entry.slot) !== record) {
          return;
        }
        const previous = [...container.querySelectorAll(`img[data-slot="${entry.slot}"]`)];
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

  function updateCaption(view, label) {
    const roof = findRoof(view.roof);
    const palette = findPalette(view.palette);
    const caption = byId("stage-caption");
    if (label) {
      caption.replaceChildren(h("strong", { text: "Watch it build" }), ` / ${label}`);
    } else {
      caption.replaceChildren(
        h("strong", { text: currentModel().name }),
        ` / ${roof.name} roof / ${palette.name}`,
      );
    }
    const upgrades = [...view.upgrades].map((id) => findUpgrade(id).name.toLowerCase());
    byId("stage-layers").setAttribute(
      "aria-label",
      `${currentModel().name} with a ${roof.name.toLowerCase()} roof in ${palette.name}` +
        (upgrades.length ? `, with ${upgrades.join(", ")}` : ""),
    );
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

  function prefetchForStep() {
    const cladding = claddingFor(state.upgrades);
    const landscaped = state.upgrades.has("landscaping");
    const names = [];
    if (state.step <= 1) {
      for (const roof of config.roofs) {
        names.push(`house_${roof.id}_${state.palette}_${cladding}`);
        names.push(landscaped ? `ground_${roof.id}` : `shadow_${roof.id}`);
      }
    } else if (state.step === 2) {
      for (const palette of config.palettes) {
        names.push(`house_${state.roof}_${palette.id}_${cladding}`);
      }
    } else if (state.step === 3) {
      const view = {
        roof: state.roof,
        palette: state.palette,
        upgrades: new Set(config.upgrades.map((item) => item.id)),
      };
      for (const layer of resolveStack(view)) {
        if (layer.slot !== "house") {
          names.push(layer.name);
        }
      }
      names.push(`shadow_${state.roof}`);
      for (const variant of ["abodo", "aluminium"]) {
        names.push(`house_${state.roof}_${state.palette}_${variant}`);
      }
    }
    window.setTimeout(() => prefetch(names), 700);
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
            onclick: (event) => openLightbox(item, event.currentTarget),
          },
          item.interior === "smart"
            ? h("span", { class: "smart-thumb", "aria-hidden": "true", text: "Panel" })
            : h("img", {
                src: interiorUrl(item),
                alt: "",
                loading: "lazy",
                width: "96",
                height: "60",
              }),
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
        tile("Climate", "Heat pump", "21°", false),
        tile("Security", "Doors locked", "Armed", false),
        tile("Energy", "Solar now", "3.2 kW", true),
        tile("Battery", "Stored", "84%", false),
        tile("Water", "Tank level", "72%", false),
      ),
    );
  }

  function openLightbox(item, trigger) {
    lastFocus = trigger;
    const media = byId("lightbox-media");
    media.replaceChildren(
      item.interior === "smart"
        ? smartPanel()
        : h("img", { src: interiorUrl(item), alt: item.interiorCaption }),
    );
    byId("lightbox-caption").textContent = item.interiorCaption;
    byId("lightbox").hidden = false;
    byId("lightbox-close").focus();
  }

  function closeLightbox() {
    byId("lightbox").hidden = true;
    if (lastFocus) {
      lastFocus.focus();
    }
  }

  function stepper() {
    const nav = byId("stepper");
    const names = config.steps;
    nav.replaceChildren(
      h(
        "p",
        { class: "stepper-label" },
        h("span", { text: `Step ${state.step + 1} of ${names.length}` }),
        h("span", { text: names[state.step] }),
      ),
      h(
        "ol",
        { class: "stepper-track" },
        names.map((name, index) => {
          const reachable = index <= state.maxStep && (index < 6 || state.submitted) && !state.submitted;
          return h(
            "li",
            {},
            h("button", {
              type: "button",
              class: index === state.step ? "is-current" : index < state.step ? "is-done" : "",
              "aria-label": `Step ${index + 1}: ${name}`,
              "aria-current": index === state.step ? "step" : null,
              disabled: !reachable || index === state.step,
              onclick: () => goTo(index),
            }),
          );
        }),
      ),
    );
  }

  function heading(eyebrow, title, intro) {
    return [
      h("p", { class: "eyebrow", text: eyebrow }),
      h("h1", { class: "step-title", text: title }),
      intro ? h("p", { class: "step-intro", text: intro }) : null,
    ];
  }

  function optionButton({ key, pressed, disabled, onclick, lead, name, summary, price, extraClass }) {
    return h(
      "li",
      {},
      h(
        "button",
        {
          type: "button",
          class: `option ${extraClass || ""}`.trim(),
          "aria-pressed": pressed ? "true" : "false",
          "data-key": key,
          disabled,
          onclick,
        },
        lead,
        h(
          "span",
          {},
          h("span", { class: "option-name", text: name }),
          summary ? h("span", { class: "option-summary", text: summary }) : null,
        ),
        price,
      ),
    );
  }

  function priceTag(main, detail, withCheck) {
    return h(
      "span",
      { class: "option-price" },
      main,
      withCheck ? h("span", { class: "check", "aria-hidden": "true" }) : null,
      detail ? h("small", { text: detail }) : null,
    );
  }

  function modelStep() {
    return [
      ...heading("Floor plan", "Choose your floor plan", "Start with the pod that suits how you want to live."),
      h(
        "ul",
        { class: "option-list" },
        config.models.map((model) =>
          optionButton({
            key: `model:${model.id}`,
            extraClass: "model-option",
            pressed: model.id === state.model,
            disabled: !model.available,
            onclick: () => {
              state.model = model.id;
              render();
            },
            lead: h("img", { src: model.thumbnail, alt: "", width: "112", height: "70", loading: "lazy" }),
            name: model.name,
            summary: `${model.range}, ${model.size}`,
            price: model.available
              ? priceTag(
                  model.basePrice === null ? "Price TBC" : formatPrice(model.basePrice),
                  model.basePrice === null ? "Base price" : "From",
                )
              : h("span", { class: "tag", text: "Coming soon" }),
          }),
        ),
      ),
      h("p", {
        class: "note",
        text: "The Pavilion is the test model for this build. The other floor plans join as their layer sets are rendered.",
      }),
    ];
  }

  function roofStep() {
    const model = currentModel();
    return [
      ...heading(
        "Roof",
        "Choose a roof style",
        `Roof upgrades are priced per square metre of floor area (${model.floorArea} sq m for ${model.name}).`,
      ),
      h(
        "ul",
        { class: "option-list" },
        config.roofs.map((roof) => {
          const label = roofPriceLabel(roof);
          return optionButton({
            key: `roof:${roof.id}`,
            pressed: roof.id === state.roof,
            onclick: () => select("roof", roof.id),
            lead: svgIcon(ROOF_ICONS[roof.id]),
            name: roof.name,
            summary: roof.summary,
            price: priceTag(label.main, label.detail),
          });
        }),
      ),
    ];
  }

  function paletteStep() {
    return [
      ...heading("Colour palette", "Choose a colour palette", "Each palette sets the cladding, joinery, roofing and deck."),
      h(
        "ul",
        { class: "option-list" },
        config.palettes.map((palette) =>
          optionButton({
            key: `palette:${palette.id}`,
            pressed: palette.id === state.palette,
            onclick: () => select("palette", palette.id),
            lead: h(
              "span",
              { class: "swatches", "aria-hidden": "true" },
              palette.swatches.map((color) => h("span", { style: `background:${color}` })),
            ),
            name: palette.name,
            summary: palette.summary,
            price: priceTag("Included"),
          }),
        ),
      ),
    ];
  }

  function upgradesStep() {
    const blocks = UPGRADE_GROUPS.map((group) => [
      h("h2", { class: "upgrade-group-title", text: group.title }),
      h(
        "ul",
        { class: "option-list" },
        group.ids.map((id) => {
          const item = findUpgrade(id);
          return optionButton({
            key: `upgrade:${id}`,
            pressed: state.upgrades.has(id),
            onclick: () => {
              stopPlayback();
              toggleUpgrade(id);
              render();
            },
            lead: h("span", { class: "upgrade-number", text: item.number }),
            name: item.name,
            summary: item.summary,
            price: priceTag(upgradePriceLabel(item), "", true),
          });
        }),
      ),
    ]);
    return [
      ...heading(
        "Upgrades",
        "Add upgrades",
        "Each upgrade appears on your pod as you add it. Abodo and aluminium cladding are alternatives, so choosing one replaces the other.",
      ),
      ...blocks.flat(),
    ];
  }

  function estimateStep() {
    const summary = pricing();
    const rows = summary.lines.map((line) =>
      h(
        "tr",
        {},
        h("th", { scope: "row" }, line.label, line.detail ? h("small", { text: line.detail }) : null),
        h("td", { text: line.display ?? formatPrice(line.value) }),
      ),
    );
    rows.push(
      h("tr", {}, h("th", { scope: "row", text: "Options subtotal" }), h("td", { text: formatPrice(summary.options) })),
    );
    rows.push(
      h(
        "tr",
        { class: "estimate-total" },
        h("th", { scope: "row", text: "Estimated project value" }),
        h("td", {
          text:
            summary.total === null
              ? `Base + ${formatPrice(summary.options)}`
              : formatPrice(summary.total),
        }),
      ),
    );
    return [
      ...heading("Estimate", "Your estimate"),
      h("table", { class: "estimate" }, h("tbody", {}, rows)),
      h("p", {
        class: "note",
        text:
          (summary.basePrice === null
            ? `The ${currentModel().name} base price is to be confirmed by NOOK. `
            : "") +
          (summary.hasPoa ? "Transport and delivery is priced on application. " : "") +
          `Upgrade prices are "from" prices in ${config.currency}. ${config.priceNote}`,
      }),
    ];
  }

  function detailsStep() {
    const fields = DETAIL_FIELDS.map((field) => {
      const error = state.errors[field.id];
      return h(
        "div",
        { class: error ? "field has-error" : "field" },
        h("label", { for: `field-${field.id}`, text: field.label }),
        h("input", {
          id: `field-${field.id}`,
          name: field.id,
          type: field.type,
          autocomplete: field.autocomplete,
          placeholder: field.placeholder || null,
          value: state.customer[field.id],
          required: true,
          "aria-invalid": error ? "true" : "false",
          "aria-describedby": error ? `error-${field.id}` : null,
          oninput: (event) => {
            state.customer[field.id] = event.target.value;
          },
        }),
        error ? h("p", { class: "field-error", id: `error-${field.id}`, text: error }) : null,
      );
    });
    return [
      ...heading(
        "Your details",
        "Where should we send your design?",
        "We will email your summary to you and to the NOOK team, who will be in touch to talk it through.",
      ),
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
        fields,
        h(
          "div",
          { class: "field" },
          h("label", { for: "field-notes", text: "Anything we should know (optional)" }),
          h(
            "textarea",
            {
              id: "field-notes",
              name: "notes",
              rows: "3",
              oninput: (event) => {
                state.customer.notes = event.target.value;
              },
            },
            state.customer.notes,
          ),
        ),
        h(
          "label",
          { class: state.errors.consent ? "consent field has-error" : "consent" },
          h("input", {
            type: "checkbox",
            name: "consent",
            checked: state.customer.consent,
            onchange: (event) => {
              state.customer.consent = event.target.checked;
            },
          }),
          h("span", {
            text: "I agree to NOOK contacting me about this design and storing these details for that purpose.",
          }),
        ),
        state.errors.consent ? h("p", { class: "field-error", text: state.errors.consent }) : null,
        h("button", { type: "submit", hidden: true }),
      ),
    ];
  }

  function summaryList() {
    const summary = pricing();
    const upgrades = config.upgrades
      .filter((item) => state.upgrades.has(item.id) && item.group !== "cladding")
      .map((item) => item.name);
    const rows = [
      ["Floor plan", `${currentModel().name} (${currentModel().range}, ${currentModel().size})`],
      ["Roof", findRoof(state.roof).name],
      ["Colour palette", findPalette(state.palette).name],
      ["Cladding", claddingName(state.upgrades)],
      ["Upgrades", upgrades.length ? upgrades.join(", ") : "None"],
      [
        "Estimated value",
        summary.total === null
          ? `${formatPrice(summary.options)} in options, plus the base price (TBC)`
          : formatPrice(summary.total),
      ],
    ];
    return rows;
  }

  function summaryStep() {
    const rows = summaryList();
    const customer = state.customer;
    const testMode = !config.submitEndpoint;
    return [
      ...heading("Summary", "Your NOOK design"),
      h("p", {
        class: testMode ? "banner" : "banner is-success",
        role: "status",
        text: testMode
          ? "Test mode: no email was sent. On the live site this summary goes to you and to the NOOK team."
          : `Thank you, ${customer.name}. Your design is on its way to ${customer.email} and the NOOK team.`,
      }),
      state.summaryImage
        ? h("img", {
            class: "summary-image",
            src: state.summaryImage,
            alt: byId("stage-layers").getAttribute("aria-label"),
          })
        : null,
      h(
        "dl",
        { class: "summary-list" },
        rows.map(([term, value]) => [h("dt", { text: term }), h("dd", { text: value })]),
        h("dt", { text: "Name" }),
        h("dd", { text: customer.name }),
        h("dt", { text: "Email" }),
        h("dd", { text: customer.email }),
        h("dt", { text: "Phone" }),
        h("dd", { text: customer.phone }),
        h("dt", { text: "Build location" }),
        h("dd", { text: customer.location }),
      ),
      h(
        "div",
        { class: "summary-actions" },
        state.summaryImage
          ? h("a", {
              class: "link-button",
              href: state.summaryImage,
              download: `NOOK-${currentModel().name.replace(/\s+/g, "-")}-design.jpg`,
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
    if (customer.name.trim().length < 2) {
      errors.name = "Please enter your name.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email.trim())) {
      errors.email = "Please enter a valid email address.";
    }
    if (customer.phone.replace(/\D/g, "").length < 8) {
      errors.phone = "Please enter a phone number we can reach you on.";
    }
    if (customer.location.trim().length < 2) {
      errors.location = "Please tell us where you plan to build.";
    }
    if (!customer.consent) {
      errors.consent = "Please confirm we can contact you about this design.";
    }
    state.errors = errors;
    return Object.keys(errors).length === 0;
  }

  function cropFor(bounds, sourceWidth, sourceHeight) {
    if (!bounds) {
      return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    }
    const aspect = sourceWidth / sourceHeight;
    let width = (bounds[2] - bounds[0] + 2 * FRAME_PADDING) * sourceWidth;
    let height = (bounds[3] - bounds[1] + 2 * FRAME_PADDING) * sourceHeight;
    if (width / height > aspect) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
    width = Math.min(width, sourceWidth);
    height = Math.min(height, sourceHeight);
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
    const images = await Promise.all(layers.map((layer) => loadImage(layerUrl(layer.name, true))));
    const model = currentModel();
    const crop = cropFor(unionBounds(layers), model.imageWidth, model.imageHeight);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((width * crop.height) / crop.width);
    const context = canvas.getContext("2d");
    context.fillStyle = "#f3f1ed";
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (const image of images) {
      context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    }
    return canvas.toDataURL("image/jpeg", 0.88);
  }

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (character) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
    );
  }

  function emailHtml(rows, customer, lines) {
    const tableRows = (pairs) =>
      pairs
        .map(
          ([term, value]) =>
            `<tr><td style="padding:6px 16px 6px 0;color:#6e6c69">${escapeHtml(term)}</td>` +
            `<td style="padding:6px 0">${escapeHtml(value)}</td></tr>`,
        )
        .join("");
    const priceRows = lines.map((line) => [line.label, line.display ?? formatPrice(line.value)]);
    return (
      '<div style="font-family:Arial,Helvetica,sans-serif;color:#141414;max-width:640px">' +
      '<h1 style="font-weight:400;font-size:24px">Your NOOK design</h1>' +
      `<p>Hi ${escapeHtml(customer.name)}, here is the design you built in the NOOK configurator.</p>` +
      `<table style="border-collapse:collapse;font-size:14px">${tableRows(rows)}</table>` +
      '<h2 style="font-weight:400;font-size:18px;margin-top:24px">Estimate</h2>' +
      `<table style="border-collapse:collapse;font-size:14px">${tableRows(priceRows)}</table>` +
      `<p style="font-size:12px;color:#6e6c69">${escapeHtml(config.priceNote)}</p>` +
      "</div>"
    );
  }

  function buildPayload(image) {
    const summary = pricing();
    const rows = summaryList();
    const customer = { ...state.customer };
    return {
      submittedAt: new Date().toISOString(),
      customer,
      configuration: {
        model: state.model,
        roof: state.roof,
        palette: state.palette,
        cladding: claddingFor(state.upgrades),
        upgrades: [...state.upgrades],
      },
      pricing: {
        currency: config.currency,
        lines: summary.lines.map((line) => ({
          label: line.label,
          value: line.value,
          display: line.display,
        })),
        optionsTotal: summary.options,
        estimatedTotal: summary.total,
        basePriceConfirmed: summary.basePrice !== null,
      },
      designUrl: location.href,
      imageDataUrl: image,
      emailHtml: emailHtml(rows, customer, summary.lines),
    };
  }

  async function submit() {
    if (state.sending) {
      return;
    }
    if (!validate()) {
      render();
      const firstError = document.querySelector('[aria-invalid="true"], .consent.has-error input');
      if (firstError) {
        firstError.focus();
      }
      return;
    }
    state.sending = true;
    state.sendError = "";
    renderFooter();
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
      state.step = 6;
      state.maxStep = 6;
    } catch (error) {
      state.sendError = "Sorry, we could not send your design just now. Please try again in a moment.";
    } finally {
      state.sending = false;
      render();
    }
  }

  function restart() {
    state.step = 0;
    state.maxStep = 0;
    state.roof = "box";
    state.palette = "A";
    state.upgrades = new Set();
    state.submitted = false;
    state.summaryImage = "";
    state.errors = {};
    render();
  }

  function select(key, value) {
    stopPlayback();
    state[key] = value;
    render();
  }

  function goTo(step) {
    stopPlayback();
    state.step = step;
    state.maxStep = Math.max(state.maxStep, step);
    render();
    byId("panel-body").focus({ preventScroll: true });
    byId("panel-body").scrollTop = 0;
  }

  function renderFooter() {
    const summary = pricing();
    const totalValue = byId("total-value");
    const totalNote = byId("total-note");
    if (summary.total === null) {
      totalValue.textContent = summary.options ? `Base + ${formatPrice(summary.options)}` : "Base price";
      totalNote.textContent = "Base price to be confirmed";
    } else {
      totalValue.textContent = formatPrice(summary.total);
      totalNote.textContent = summary.hasPoa ? "Plus transport (POA)" : "Indicative, incl. selected options";
    }
    const back = byId("back-button");
    const next = byId("next-button");
    back.hidden = state.step === 0 || state.submitted;
    next.hidden = state.submitted;
    next.disabled = state.sending;
    if (state.step === 5) {
      next.textContent = state.sending ? "Sending" : "Send my design";
    } else {
      next.textContent = `Next: ${config.steps[state.step + 1]}`;
    }
  }

  function render() {
    stepper();
    const body = byId("panel-body");
    const focusedKey = document.activeElement?.dataset?.key;
    const builders = [modelStep, roofStep, paletteStep, upgradesStep, estimateStep, detailsStep, summaryStep];
    body.replaceChildren(...builders[state.step]().filter(Boolean));
    if (focusedKey) {
      body.querySelector(`[data-key="${focusedKey}"]`)?.focus({ preventScroll: true });
    }
    renderFooter();
    if (!playback) {
      renderStage(state);
    }
    renderInteriors();
    if (!state.submitted) {
      writeHash();
    }
    prefetchForStep();
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
    const names = new Set(config.buildSequence.flatMap((frame) => resolveStack(sequenceView(frame)).map((layer) => layer.name)));
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
    byId("back-button").addEventListener("click", () => goTo(Math.max(0, state.step - 1)));
    byId("next-button").addEventListener("click", () => {
      if (state.step === 5) {
        submit();
      } else {
        goTo(Math.min(5, state.step + 1));
      }
    });
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
      resizeTimer = window.setTimeout(() => frameStage(framedBounds, false), 120);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !byId("lightbox").hidden) {
        closeLightbox();
      }
    });
  }

  async function init() {
    try {
      const response = await fetch("data/configurator.json", { cache: "no-cache" });
      config = await response.json();
    } catch (error) {
      byId("panel-body").textContent = "The configurator could not load its data. Please refresh the page.";
      return;
    }
    money = new Intl.NumberFormat(config.locale, {
      style: "currency",
      currency: config.currency,
      maximumFractionDigits: 0,
    });
    try {
      const manifest = await (await fetch(`${currentModel().layers}manifest.json`, { cache: "no-cache" })).json();
      layerBounds = Object.fromEntries(
        Object.entries(manifest.layers).map(([name, entry]) => [name, entry.bounds]),
      );
    } catch (error) {
      layerBounds = {};
    }
    const stageWidth = byId("stage").clientWidth || window.innerWidth;
    layerSuffix = stageWidth * (window.devicePixelRatio || 1) > 1400 ? "" : "-1280";
    readHash();
    bindChrome();
    render();
  }

  init();
})();
