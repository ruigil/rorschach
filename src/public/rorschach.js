var __legacyDecorateClassTS = function(decorators, target, key, desc) {
  var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
  if (typeof Reflect === "object" && typeof Reflect.decorate === "function")
    r = Reflect.decorate(decorators, target, key, desc);
  else
    for (var i = decorators.length - 1;i >= 0; i--)
      if (d = decorators[i])
        r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
  return c > 3 && r && Object.defineProperty(target, key, r), r;
};

// node_modules/@lit/reactive-element/development/css-tag.js
var NODE_MODE = false;
var global = globalThis;
var supportsAdoptingStyleSheets = global.ShadowRoot && (global.ShadyCSS === undefined || global.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype;
var constructionToken = Symbol();
var cssTagCache = new WeakMap;

class CSSResult {
  constructor(cssText, strings, safeToken) {
    this["_$cssResult$"] = true;
    if (safeToken !== constructionToken) {
      throw new Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
    }
    this.cssText = cssText;
    this._strings = strings;
  }
  get styleSheet() {
    let styleSheet = this._styleSheet;
    const strings = this._strings;
    if (supportsAdoptingStyleSheets && styleSheet === undefined) {
      const cacheable = strings !== undefined && strings.length === 1;
      if (cacheable) {
        styleSheet = cssTagCache.get(strings);
      }
      if (styleSheet === undefined) {
        (this._styleSheet = styleSheet = new CSSStyleSheet).replaceSync(this.cssText);
        if (cacheable) {
          cssTagCache.set(strings, styleSheet);
        }
      }
    }
    return styleSheet;
  }
  toString() {
    return this.cssText;
  }
}
var textFromCSSResult = (value) => {
  if (value["_$cssResult$"] === true) {
    return value.cssText;
  } else if (typeof value === "number") {
    return value;
  } else {
    throw new Error(`Value passed to 'css' function must be a 'css' function result: ` + `${value}. Use 'unsafeCSS' to pass non-literal values, but take care ` + `to ensure page security.`);
  }
};
var unsafeCSS = (value) => new CSSResult(typeof value === "string" ? value : String(value), undefined, constructionToken);
var css = (strings, ...values) => {
  const cssText = strings.length === 1 ? strings[0] : values.reduce((acc, v, idx) => acc + textFromCSSResult(v) + strings[idx + 1], strings[0]);
  return new CSSResult(cssText, strings, constructionToken);
};
var adoptStyles = (renderRoot, styles) => {
  if (supportsAdoptingStyleSheets) {
    renderRoot.adoptedStyleSheets = styles.map((s) => s instanceof CSSStyleSheet ? s : s.styleSheet);
  } else {
    for (const s of styles) {
      const style = document.createElement("style");
      const nonce = global["litNonce"];
      if (nonce !== undefined) {
        style.setAttribute("nonce", nonce);
      }
      style.textContent = s.cssText;
      renderRoot.appendChild(style);
    }
  }
};
var cssResultFromStyleSheet = (sheet) => {
  let cssText = "";
  for (const rule of sheet.cssRules) {
    cssText += rule.cssText;
  }
  return unsafeCSS(cssText);
};
var getCompatibleStyle = supportsAdoptingStyleSheets || NODE_MODE && global.CSSStyleSheet === undefined ? (s) => s : (s) => s instanceof CSSStyleSheet ? cssResultFromStyleSheet(s) : s;

// node_modules/@lit/reactive-element/development/reactive-element.js
var { is, defineProperty, getOwnPropertyDescriptor, getOwnPropertyNames, getOwnPropertySymbols, getPrototypeOf } = Object;
var NODE_MODE2 = false;
var global2 = globalThis;
if (NODE_MODE2) {
  global2.customElements ??= customElements;
}
var DEV_MODE = true;
var issueWarning;
var trustedTypes = global2.trustedTypes;
var emptyStringForBooleanAttribute = trustedTypes ? trustedTypes.emptyScript : "";
var polyfillSupport = DEV_MODE ? global2.reactiveElementPolyfillSupportDevMode : global2.reactiveElementPolyfillSupport;
if (DEV_MODE) {
  global2.litIssuedWarnings ??= new Set;
  issueWarning = (code, warning) => {
    warning += ` See https://lit.dev/msg/${code} for more information.`;
    if (!global2.litIssuedWarnings.has(warning) && !global2.litIssuedWarnings.has(code)) {
      console.warn(warning);
      global2.litIssuedWarnings.add(warning);
    }
  };
  queueMicrotask(() => {
    issueWarning("dev-mode", `Lit is in dev mode. Not recommended for production!`);
    if (global2.ShadyDOM?.inUse && polyfillSupport === undefined) {
      issueWarning("polyfill-support-missing", `Shadow DOM is being polyfilled via \`ShadyDOM\` but ` + `the \`polyfill-support\` module has not been loaded.`);
    }
  });
}
var debugLogEvent = DEV_MODE ? (event) => {
  const shouldEmit = global2.emitLitDebugLogEvents;
  if (!shouldEmit) {
    return;
  }
  global2.dispatchEvent(new CustomEvent("lit-debug", {
    detail: event
  }));
} : undefined;
var JSCompiler_renameProperty = (prop, _obj) => prop;
var defaultConverter = {
  toAttribute(value, type) {
    switch (type) {
      case Boolean:
        value = value ? emptyStringForBooleanAttribute : null;
        break;
      case Object:
      case Array:
        value = value == null ? value : JSON.stringify(value);
        break;
    }
    return value;
  },
  fromAttribute(value, type) {
    let fromValue = value;
    switch (type) {
      case Boolean:
        fromValue = value !== null;
        break;
      case Number:
        fromValue = value === null ? null : Number(value);
        break;
      case Object:
      case Array:
        try {
          fromValue = JSON.parse(value);
        } catch (e) {
          fromValue = null;
        }
        break;
    }
    return fromValue;
  }
};
var notEqual = (value, old) => !is(value, old);
var defaultPropertyDeclaration = {
  attribute: true,
  type: String,
  converter: defaultConverter,
  reflect: false,
  useDefault: false,
  hasChanged: notEqual
};
Symbol.metadata ??= Symbol("metadata");
global2.litPropertyMetadata ??= new WeakMap;

class ReactiveElement extends HTMLElement {
  static addInitializer(initializer) {
    this.__prepare();
    (this._initializers ??= []).push(initializer);
  }
  static get observedAttributes() {
    this.finalize();
    return this.__attributeToPropertyMap && [...this.__attributeToPropertyMap.keys()];
  }
  static createProperty(name, options = defaultPropertyDeclaration) {
    if (options.state) {
      options.attribute = false;
    }
    this.__prepare();
    if (this.prototype.hasOwnProperty(name)) {
      options = Object.create(options);
      options.wrapped = true;
    }
    this.elementProperties.set(name, options);
    if (!options.noAccessor) {
      const key = DEV_MODE ? Symbol.for(`${String(name)} (@property() cache)`) : Symbol();
      const descriptor = this.getPropertyDescriptor(name, key, options);
      if (descriptor !== undefined) {
        defineProperty(this.prototype, name, descriptor);
      }
    }
  }
  static getPropertyDescriptor(name, key, options) {
    const { get, set } = getOwnPropertyDescriptor(this.prototype, name) ?? {
      get() {
        return this[key];
      },
      set(v) {
        this[key] = v;
      }
    };
    if (DEV_MODE && get == null) {
      if ("value" in (getOwnPropertyDescriptor(this.prototype, name) ?? {})) {
        throw new Error(`Field ${JSON.stringify(String(name))} on ` + `${this.name} was declared as a reactive property ` + `but it's actually declared as a value on the prototype. ` + `Usually this is due to using @property or @state on a method.`);
      }
      issueWarning("reactive-property-without-getter", `Field ${JSON.stringify(String(name))} on ` + `${this.name} was declared as a reactive property ` + `but it does not have a getter. This will be an error in a ` + `future version of Lit.`);
    }
    return {
      get,
      set(value) {
        const oldValue = get?.call(this);
        set?.call(this, value);
        this.requestUpdate(name, oldValue, options);
      },
      configurable: true,
      enumerable: true
    };
  }
  static getPropertyOptions(name) {
    return this.elementProperties.get(name) ?? defaultPropertyDeclaration;
  }
  static __prepare() {
    if (this.hasOwnProperty(JSCompiler_renameProperty("elementProperties", this))) {
      return;
    }
    const superCtor = getPrototypeOf(this);
    superCtor.finalize();
    if (superCtor._initializers !== undefined) {
      this._initializers = [...superCtor._initializers];
    }
    this.elementProperties = new Map(superCtor.elementProperties);
  }
  static finalize() {
    if (this.hasOwnProperty(JSCompiler_renameProperty("finalized", this))) {
      return;
    }
    this.finalized = true;
    this.__prepare();
    if (this.hasOwnProperty(JSCompiler_renameProperty("properties", this))) {
      const props = this.properties;
      const propKeys = [
        ...getOwnPropertyNames(props),
        ...getOwnPropertySymbols(props)
      ];
      for (const p of propKeys) {
        this.createProperty(p, props[p]);
      }
    }
    const metadata = this[Symbol.metadata];
    if (metadata !== null) {
      const properties = litPropertyMetadata.get(metadata);
      if (properties !== undefined) {
        for (const [p, options] of properties) {
          this.elementProperties.set(p, options);
        }
      }
    }
    this.__attributeToPropertyMap = new Map;
    for (const [p, options] of this.elementProperties) {
      const attr = this.__attributeNameForProperty(p, options);
      if (attr !== undefined) {
        this.__attributeToPropertyMap.set(attr, p);
      }
    }
    this.elementStyles = this.finalizeStyles(this.styles);
    if (DEV_MODE) {
      if (this.hasOwnProperty("createProperty")) {
        issueWarning("no-override-create-property", "Overriding ReactiveElement.createProperty() is deprecated. " + "The override will not be called with standard decorators");
      }
      if (this.hasOwnProperty("getPropertyDescriptor")) {
        issueWarning("no-override-get-property-descriptor", "Overriding ReactiveElement.getPropertyDescriptor() is deprecated. " + "The override will not be called with standard decorators");
      }
    }
  }
  static finalizeStyles(styles) {
    const elementStyles = [];
    if (Array.isArray(styles)) {
      const set = new Set(styles.flat(Infinity).reverse());
      for (const s of set) {
        elementStyles.unshift(getCompatibleStyle(s));
      }
    } else if (styles !== undefined) {
      elementStyles.push(getCompatibleStyle(styles));
    }
    return elementStyles;
  }
  static __attributeNameForProperty(name, options) {
    const attribute = options.attribute;
    return attribute === false ? undefined : typeof attribute === "string" ? attribute : typeof name === "string" ? name.toLowerCase() : undefined;
  }
  constructor() {
    super();
    this.__instanceProperties = undefined;
    this.isUpdatePending = false;
    this.hasUpdated = false;
    this.__reflectingProperty = null;
    this.__initialize();
  }
  __initialize() {
    this.__updatePromise = new Promise((res) => this.enableUpdating = res);
    this._$changedProperties = new Map;
    this.__saveInstanceProperties();
    this.requestUpdate();
    this.constructor._initializers?.forEach((i) => i(this));
  }
  addController(controller) {
    (this.__controllers ??= new Set).add(controller);
    if (this.renderRoot !== undefined && this.isConnected) {
      controller.hostConnected?.();
    }
  }
  removeController(controller) {
    this.__controllers?.delete(controller);
  }
  __saveInstanceProperties() {
    const instanceProperties = new Map;
    const elementProperties = this.constructor.elementProperties;
    for (const p of elementProperties.keys()) {
      if (this.hasOwnProperty(p)) {
        instanceProperties.set(p, this[p]);
        delete this[p];
      }
    }
    if (instanceProperties.size > 0) {
      this.__instanceProperties = instanceProperties;
    }
  }
  createRenderRoot() {
    const renderRoot = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
    adoptStyles(renderRoot, this.constructor.elementStyles);
    return renderRoot;
  }
  connectedCallback() {
    this.renderRoot ??= this.createRenderRoot();
    this.enableUpdating(true);
    this.__controllers?.forEach((c) => c.hostConnected?.());
  }
  enableUpdating(_requestedUpdate) {}
  disconnectedCallback() {
    this.__controllers?.forEach((c) => c.hostDisconnected?.());
  }
  attributeChangedCallback(name, _old, value) {
    this._$attributeToProperty(name, value);
  }
  __propertyToAttribute(name, value) {
    const elemProperties = this.constructor.elementProperties;
    const options = elemProperties.get(name);
    const attr = this.constructor.__attributeNameForProperty(name, options);
    if (attr !== undefined && options.reflect === true) {
      const converter = options.converter?.toAttribute !== undefined ? options.converter : defaultConverter;
      const attrValue = converter.toAttribute(value, options.type);
      if (DEV_MODE && this.constructor.enabledWarnings.includes("migration") && attrValue === undefined) {
        issueWarning("undefined-attribute-value", `The attribute value for the ${name} property is ` + `undefined on element ${this.localName}. The attribute will be ` + `removed, but in the previous version of \`ReactiveElement\`, ` + `the attribute would not have changed.`);
      }
      this.__reflectingProperty = name;
      if (attrValue == null) {
        this.removeAttribute(attr);
      } else {
        this.setAttribute(attr, attrValue);
      }
      this.__reflectingProperty = null;
    }
  }
  _$attributeToProperty(name, value) {
    const ctor = this.constructor;
    const propName = ctor.__attributeToPropertyMap.get(name);
    if (propName !== undefined && this.__reflectingProperty !== propName) {
      const options = ctor.getPropertyOptions(propName);
      const converter = typeof options.converter === "function" ? { fromAttribute: options.converter } : options.converter?.fromAttribute !== undefined ? options.converter : defaultConverter;
      this.__reflectingProperty = propName;
      const convertedValue = converter.fromAttribute(value, options.type);
      this[propName] = convertedValue ?? this.__defaultValues?.get(propName) ?? convertedValue;
      this.__reflectingProperty = null;
    }
  }
  requestUpdate(name, oldValue, options, useNewValue = false, newValue) {
    if (name !== undefined) {
      if (DEV_MODE && name instanceof Event) {
        issueWarning(``, `The requestUpdate() method was called with an Event as the property name. This is probably a mistake caused by binding this.requestUpdate as an event listener. Instead bind a function that will call it with no arguments: () => this.requestUpdate()`);
      }
      const ctor = this.constructor;
      if (useNewValue === false) {
        newValue = this[name];
      }
      options ??= ctor.getPropertyOptions(name);
      const changed = (options.hasChanged ?? notEqual)(newValue, oldValue) || options.useDefault && options.reflect && newValue === this.__defaultValues?.get(name) && !this.hasAttribute(ctor.__attributeNameForProperty(name, options));
      if (changed) {
        this._$changeProperty(name, oldValue, options);
      } else {
        return;
      }
    }
    if (this.isUpdatePending === false) {
      this.__updatePromise = this.__enqueueUpdate();
    }
  }
  _$changeProperty(name, oldValue, { useDefault, reflect, wrapped }, initializeValue) {
    if (useDefault && !(this.__defaultValues ??= new Map).has(name)) {
      this.__defaultValues.set(name, initializeValue ?? oldValue ?? this[name]);
      if (wrapped !== true || initializeValue !== undefined) {
        return;
      }
    }
    if (!this._$changedProperties.has(name)) {
      if (!this.hasUpdated && !useDefault) {
        oldValue = undefined;
      }
      this._$changedProperties.set(name, oldValue);
    }
    if (reflect === true && this.__reflectingProperty !== name) {
      (this.__reflectingProperties ??= new Set).add(name);
    }
  }
  async __enqueueUpdate() {
    this.isUpdatePending = true;
    try {
      await this.__updatePromise;
    } catch (e) {
      Promise.reject(e);
    }
    const result = this.scheduleUpdate();
    if (result != null) {
      await result;
    }
    return !this.isUpdatePending;
  }
  scheduleUpdate() {
    const result = this.performUpdate();
    if (DEV_MODE && this.constructor.enabledWarnings.includes("async-perform-update") && typeof result?.then === "function") {
      issueWarning("async-perform-update", `Element ${this.localName} returned a Promise from performUpdate(). ` + `This behavior is deprecated and will be removed in a future ` + `version of ReactiveElement.`);
    }
    return result;
  }
  performUpdate() {
    if (!this.isUpdatePending) {
      return;
    }
    debugLogEvent?.({ kind: "update" });
    if (!this.hasUpdated) {
      this.renderRoot ??= this.createRenderRoot();
      if (DEV_MODE) {
        const ctor = this.constructor;
        const shadowedProperties = [...ctor.elementProperties.keys()].filter((p) => this.hasOwnProperty(p) && (p in getPrototypeOf(this)));
        if (shadowedProperties.length) {
          throw new Error(`The following properties on element ${this.localName} will not ` + `trigger updates as expected because they are set using class ` + `fields: ${shadowedProperties.join(", ")}. ` + `Native class fields and some compiled output will overwrite ` + `accessors used for detecting changes. See ` + `https://lit.dev/msg/class-field-shadowing ` + `for more information.`);
        }
      }
      if (this.__instanceProperties) {
        for (const [p, value] of this.__instanceProperties) {
          this[p] = value;
        }
        this.__instanceProperties = undefined;
      }
      const elementProperties = this.constructor.elementProperties;
      if (elementProperties.size > 0) {
        for (const [p, options] of elementProperties) {
          const { wrapped } = options;
          const value = this[p];
          if (wrapped === true && !this._$changedProperties.has(p) && value !== undefined) {
            this._$changeProperty(p, undefined, options, value);
          }
        }
      }
    }
    let shouldUpdate = false;
    const changedProperties = this._$changedProperties;
    try {
      shouldUpdate = this.shouldUpdate(changedProperties);
      if (shouldUpdate) {
        this.willUpdate(changedProperties);
        this.__controllers?.forEach((c) => c.hostUpdate?.());
        this.update(changedProperties);
      } else {
        this.__markUpdated();
      }
    } catch (e) {
      shouldUpdate = false;
      this.__markUpdated();
      throw e;
    }
    if (shouldUpdate) {
      this._$didUpdate(changedProperties);
    }
  }
  willUpdate(_changedProperties) {}
  _$didUpdate(changedProperties) {
    this.__controllers?.forEach((c) => c.hostUpdated?.());
    if (!this.hasUpdated) {
      this.hasUpdated = true;
      this.firstUpdated(changedProperties);
    }
    this.updated(changedProperties);
    if (DEV_MODE && this.isUpdatePending && this.constructor.enabledWarnings.includes("change-in-update")) {
      issueWarning("change-in-update", `Element ${this.localName} scheduled an update ` + `(generally because a property was set) ` + `after an update completed, causing a new update to be scheduled. ` + `This is inefficient and should be avoided unless the next update ` + `can only be scheduled as a side effect of the previous update.`);
    }
  }
  __markUpdated() {
    this._$changedProperties = new Map;
    this.isUpdatePending = false;
  }
  get updateComplete() {
    return this.getUpdateComplete();
  }
  getUpdateComplete() {
    return this.__updatePromise;
  }
  shouldUpdate(_changedProperties) {
    return true;
  }
  update(_changedProperties) {
    this.__reflectingProperties &&= this.__reflectingProperties.forEach((p) => this.__propertyToAttribute(p, this[p]));
    this.__markUpdated();
  }
  updated(_changedProperties) {}
  firstUpdated(_changedProperties) {}
}
ReactiveElement.elementStyles = [];
ReactiveElement.shadowRootOptions = { mode: "open" };
ReactiveElement[JSCompiler_renameProperty("elementProperties", ReactiveElement)] = new Map;
ReactiveElement[JSCompiler_renameProperty("finalized", ReactiveElement)] = new Map;
polyfillSupport?.({ ReactiveElement });
if (DEV_MODE) {
  ReactiveElement.enabledWarnings = [
    "change-in-update",
    "async-perform-update"
  ];
  const ensureOwnWarnings = function(ctor) {
    if (!ctor.hasOwnProperty(JSCompiler_renameProperty("enabledWarnings", ctor))) {
      ctor.enabledWarnings = ctor.enabledWarnings.slice();
    }
  };
  ReactiveElement.enableWarning = function(warning) {
    ensureOwnWarnings(this);
    if (!this.enabledWarnings.includes(warning)) {
      this.enabledWarnings.push(warning);
    }
  };
  ReactiveElement.disableWarning = function(warning) {
    ensureOwnWarnings(this);
    const i = this.enabledWarnings.indexOf(warning);
    if (i >= 0) {
      this.enabledWarnings.splice(i, 1);
    }
  };
}
(global2.reactiveElementVersions ??= []).push("2.1.2");
if (DEV_MODE && global2.reactiveElementVersions.length > 1) {
  queueMicrotask(() => {
    issueWarning("multiple-versions", `Multiple versions of Lit loaded. Loading multiple versions ` + `is not recommended.`);
  });
}

// node_modules/lit-html/development/lit-html.js
var DEV_MODE2 = true;
var ENABLE_EXTRA_SECURITY_HOOKS = true;
var ENABLE_SHADYDOM_NOPATCH = true;
var NODE_MODE3 = false;
var global3 = globalThis;
var debugLogEvent2 = DEV_MODE2 ? (event) => {
  const shouldEmit = global3.emitLitDebugLogEvents;
  if (!shouldEmit) {
    return;
  }
  global3.dispatchEvent(new CustomEvent("lit-debug", {
    detail: event
  }));
} : undefined;
var debugLogRenderId = 0;
var issueWarning2;
if (DEV_MODE2) {
  global3.litIssuedWarnings ??= new Set;
  issueWarning2 = (code, warning) => {
    warning += code ? ` See https://lit.dev/msg/${code} for more information.` : "";
    if (!global3.litIssuedWarnings.has(warning) && !global3.litIssuedWarnings.has(code)) {
      console.warn(warning);
      global3.litIssuedWarnings.add(warning);
    }
  };
  queueMicrotask(() => {
    issueWarning2("dev-mode", `Lit is in dev mode. Not recommended for production!`);
  });
}
var wrap = ENABLE_SHADYDOM_NOPATCH && global3.ShadyDOM?.inUse && global3.ShadyDOM?.noPatch === true ? global3.ShadyDOM.wrap : (node) => node;
var trustedTypes2 = global3.trustedTypes;
var policy = trustedTypes2 ? trustedTypes2.createPolicy("lit-html", {
  createHTML: (s) => s
}) : undefined;
var identityFunction = (value) => value;
var noopSanitizer = (_node, _name, _type) => identityFunction;
var setSanitizer = (newSanitizer) => {
  if (!ENABLE_EXTRA_SECURITY_HOOKS) {
    return;
  }
  if (sanitizerFactoryInternal !== noopSanitizer) {
    throw new Error(`Attempted to overwrite existing lit-html security policy.` + ` setSanitizeDOMValueFactory should be called at most once.`);
  }
  sanitizerFactoryInternal = newSanitizer;
};
var _testOnlyClearSanitizerFactoryDoNotCallOrElse = () => {
  sanitizerFactoryInternal = noopSanitizer;
};
var createSanitizer = (node, name, type) => {
  return sanitizerFactoryInternal(node, name, type);
};
var boundAttributeSuffix = "$lit$";
var marker = `lit$${Math.random().toFixed(9).slice(2)}$`;
var markerMatch = "?" + marker;
var nodeMarker = `<${markerMatch}>`;
var d = NODE_MODE3 && global3.document === undefined ? {
  createTreeWalker() {
    return {};
  }
} : document;
var createMarker = () => d.createComment("");
var isPrimitive = (value) => value === null || typeof value != "object" && typeof value != "function";
var isArray = Array.isArray;
var isIterable = (value) => isArray(value) || typeof value?.[Symbol.iterator] === "function";
var SPACE_CHAR = `[ 	
\f\r]`;
var ATTR_VALUE_CHAR = `[^ 	
\f\r"'\`<>=]`;
var NAME_CHAR = `[^\\s"'>=/]`;
var textEndRegex = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g;
var COMMENT_START = 1;
var TAG_NAME = 2;
var DYNAMIC_TAG_NAME = 3;
var commentEndRegex = /-->/g;
var comment2EndRegex = />/g;
var tagEndRegex = new RegExp(`>|${SPACE_CHAR}(?:(${NAME_CHAR}+)(${SPACE_CHAR}*=${SPACE_CHAR}*(?:${ATTR_VALUE_CHAR}|("|')|))|$)`, "g");
var ENTIRE_MATCH = 0;
var ATTRIBUTE_NAME = 1;
var SPACES_AND_EQUALS = 2;
var QUOTE_CHAR = 3;
var singleQuoteAttrEndRegex = /'/g;
var doubleQuoteAttrEndRegex = /"/g;
var rawTextElement = /^(?:script|style|textarea|title)$/i;
var HTML_RESULT = 1;
var SVG_RESULT = 2;
var MATHML_RESULT = 3;
var ATTRIBUTE_PART = 1;
var CHILD_PART = 2;
var PROPERTY_PART = 3;
var BOOLEAN_ATTRIBUTE_PART = 4;
var EVENT_PART = 5;
var ELEMENT_PART = 6;
var COMMENT_PART = 7;
var tag = (type) => (strings, ...values) => {
  if (DEV_MODE2 && strings.some((s) => s === undefined)) {
    console.warn(`Some template strings are undefined.
` + "This is probably caused by illegal octal escape sequences.");
  }
  if (DEV_MODE2) {
    if (values.some((val) => val?.["_$litStatic$"])) {
      issueWarning2("", `Static values 'literal' or 'unsafeStatic' cannot be used as values to non-static templates.
` + `Please use the static 'html' tag function. See https://lit.dev/docs/templates/expressions/#static-expressions`);
    }
  }
  return {
    ["_$litType$"]: type,
    strings,
    values
  };
};
var html = tag(HTML_RESULT);
var svg = tag(SVG_RESULT);
var mathml = tag(MATHML_RESULT);
var noChange = Symbol.for("lit-noChange");
var nothing = Symbol.for("lit-nothing");
var templateCache = new WeakMap;
var walker = d.createTreeWalker(d, 129);
var sanitizerFactoryInternal = noopSanitizer;
function trustFromTemplateString(tsa, stringFromTSA) {
  if (!isArray(tsa) || !tsa.hasOwnProperty("raw")) {
    let message = "invalid template strings array";
    if (DEV_MODE2) {
      message = `
          Internal Error: expected template strings to be an array
          with a 'raw' field. Faking a template strings array by
          calling html or svg like an ordinary function is effectively
          the same as calling unsafeHtml and can lead to major security
          issues, e.g. opening your code up to XSS attacks.
          If you're using the html or svg tagged template functions normally
          and still seeing this error, please file a bug at
          https://github.com/lit/lit/issues/new?template=bug_report.md
          and include information about your build tooling, if any.
        `.trim().replace(/\n */g, `
`);
    }
    throw new Error(message);
  }
  return policy !== undefined ? policy.createHTML(stringFromTSA) : stringFromTSA;
}
var getTemplateHtml = (strings, type) => {
  const l = strings.length - 1;
  const attrNames = [];
  let html2 = type === SVG_RESULT ? "<svg>" : type === MATHML_RESULT ? "<math>" : "";
  let rawTextEndRegex;
  let regex = textEndRegex;
  for (let i = 0;i < l; i++) {
    const s = strings[i];
    let attrNameEndIndex = -1;
    let attrName;
    let lastIndex = 0;
    let match;
    while (lastIndex < s.length) {
      regex.lastIndex = lastIndex;
      match = regex.exec(s);
      if (match === null) {
        break;
      }
      lastIndex = regex.lastIndex;
      if (regex === textEndRegex) {
        if (match[COMMENT_START] === "!--") {
          regex = commentEndRegex;
        } else if (match[COMMENT_START] !== undefined) {
          regex = comment2EndRegex;
        } else if (match[TAG_NAME] !== undefined) {
          if (rawTextElement.test(match[TAG_NAME])) {
            rawTextEndRegex = new RegExp(`</${match[TAG_NAME]}`, "g");
          }
          regex = tagEndRegex;
        } else if (match[DYNAMIC_TAG_NAME] !== undefined) {
          if (DEV_MODE2) {
            throw new Error("Bindings in tag names are not supported. Please use static templates instead. " + "See https://lit.dev/docs/templates/expressions/#static-expressions");
          }
          regex = tagEndRegex;
        }
      } else if (regex === tagEndRegex) {
        if (match[ENTIRE_MATCH] === ">") {
          regex = rawTextEndRegex ?? textEndRegex;
          attrNameEndIndex = -1;
        } else if (match[ATTRIBUTE_NAME] === undefined) {
          attrNameEndIndex = -2;
        } else {
          attrNameEndIndex = regex.lastIndex - match[SPACES_AND_EQUALS].length;
          attrName = match[ATTRIBUTE_NAME];
          regex = match[QUOTE_CHAR] === undefined ? tagEndRegex : match[QUOTE_CHAR] === '"' ? doubleQuoteAttrEndRegex : singleQuoteAttrEndRegex;
        }
      } else if (regex === doubleQuoteAttrEndRegex || regex === singleQuoteAttrEndRegex) {
        regex = tagEndRegex;
      } else if (regex === commentEndRegex || regex === comment2EndRegex) {
        regex = textEndRegex;
      } else {
        regex = tagEndRegex;
        rawTextEndRegex = undefined;
      }
    }
    if (DEV_MODE2) {
      console.assert(attrNameEndIndex === -1 || regex === tagEndRegex || regex === singleQuoteAttrEndRegex || regex === doubleQuoteAttrEndRegex, "unexpected parse state B");
    }
    const end = regex === tagEndRegex && strings[i + 1].startsWith("/>") ? " " : "";
    html2 += regex === textEndRegex ? s + nodeMarker : attrNameEndIndex >= 0 ? (attrNames.push(attrName), s.slice(0, attrNameEndIndex) + boundAttributeSuffix + s.slice(attrNameEndIndex)) + marker + end : s + marker + (attrNameEndIndex === -2 ? i : end);
  }
  const htmlResult = html2 + (strings[l] || "<?>") + (type === SVG_RESULT ? "</svg>" : type === MATHML_RESULT ? "</math>" : "");
  return [trustFromTemplateString(strings, htmlResult), attrNames];
};

class Template {
  constructor({ strings, ["_$litType$"]: type }, options) {
    this.parts = [];
    let node;
    let nodeIndex = 0;
    let attrNameIndex = 0;
    const partCount = strings.length - 1;
    const parts = this.parts;
    const [html2, attrNames] = getTemplateHtml(strings, type);
    this.el = Template.createElement(html2, options);
    walker.currentNode = this.el.content;
    if (type === SVG_RESULT || type === MATHML_RESULT) {
      const wrapper = this.el.content.firstChild;
      wrapper.replaceWith(...wrapper.childNodes);
    }
    while ((node = walker.nextNode()) !== null && parts.length < partCount) {
      if (node.nodeType === 1) {
        if (DEV_MODE2) {
          const tag2 = node.localName;
          if (/^(?:textarea|template)$/i.test(tag2) && node.innerHTML.includes(marker)) {
            const m = `Expressions are not supported inside \`${tag2}\` ` + `elements. See https://lit.dev/msg/expression-in-${tag2} for more ` + `information.`;
            if (tag2 === "template") {
              throw new Error(m);
            } else
              issueWarning2("", m);
          }
        }
        if (node.hasAttributes()) {
          for (const name of node.getAttributeNames()) {
            if (name.endsWith(boundAttributeSuffix)) {
              const realName = attrNames[attrNameIndex++];
              const value = node.getAttribute(name);
              const statics = value.split(marker);
              const m = /([.?@])?(.*)/.exec(realName);
              parts.push({
                type: ATTRIBUTE_PART,
                index: nodeIndex,
                name: m[2],
                strings: statics,
                ctor: m[1] === "." ? PropertyPart : m[1] === "?" ? BooleanAttributePart : m[1] === "@" ? EventPart : AttributePart
              });
              node.removeAttribute(name);
            } else if (name.startsWith(marker)) {
              parts.push({
                type: ELEMENT_PART,
                index: nodeIndex
              });
              node.removeAttribute(name);
            }
          }
        }
        if (rawTextElement.test(node.tagName)) {
          const strings2 = node.textContent.split(marker);
          const lastIndex = strings2.length - 1;
          if (lastIndex > 0) {
            node.textContent = trustedTypes2 ? trustedTypes2.emptyScript : "";
            for (let i = 0;i < lastIndex; i++) {
              node.append(strings2[i], createMarker());
              walker.nextNode();
              parts.push({ type: CHILD_PART, index: ++nodeIndex });
            }
            node.append(strings2[lastIndex], createMarker());
          }
        }
      } else if (node.nodeType === 8) {
        const data = node.data;
        if (data === markerMatch) {
          parts.push({ type: CHILD_PART, index: nodeIndex });
        } else {
          let i = -1;
          while ((i = node.data.indexOf(marker, i + 1)) !== -1) {
            parts.push({ type: COMMENT_PART, index: nodeIndex });
            i += marker.length - 1;
          }
        }
      }
      nodeIndex++;
    }
    if (DEV_MODE2) {
      if (attrNames.length !== attrNameIndex) {
        throw new Error(`Detected duplicate attribute bindings. This occurs if your template ` + `has duplicate attributes on an element tag. For example ` + `"<input ?disabled=\${true} ?disabled=\${false}>" contains a ` + `duplicate "disabled" attribute. The error was detected in ` + `the following template: 
` + "`" + strings.join("${...}") + "`");
      }
    }
    debugLogEvent2 && debugLogEvent2({
      kind: "template prep",
      template: this,
      clonableTemplate: this.el,
      parts: this.parts,
      strings
    });
  }
  static createElement(html2, _options) {
    const el = d.createElement("template");
    el.innerHTML = html2;
    return el;
  }
}
function resolveDirective(part, value, parent = part, attributeIndex) {
  if (value === noChange) {
    return value;
  }
  let currentDirective = attributeIndex !== undefined ? parent.__directives?.[attributeIndex] : parent.__directive;
  const nextDirectiveConstructor = isPrimitive(value) ? undefined : value["_$litDirective$"];
  if (currentDirective?.constructor !== nextDirectiveConstructor) {
    currentDirective?.["_$notifyDirectiveConnectionChanged"]?.(false);
    if (nextDirectiveConstructor === undefined) {
      currentDirective = undefined;
    } else {
      currentDirective = new nextDirectiveConstructor(part);
      currentDirective._$initialize(part, parent, attributeIndex);
    }
    if (attributeIndex !== undefined) {
      (parent.__directives ??= [])[attributeIndex] = currentDirective;
    } else {
      parent.__directive = currentDirective;
    }
  }
  if (currentDirective !== undefined) {
    value = resolveDirective(part, currentDirective._$resolve(part, value.values), currentDirective, attributeIndex);
  }
  return value;
}

class TemplateInstance {
  constructor(template, parent) {
    this._$parts = [];
    this._$disconnectableChildren = undefined;
    this._$template = template;
    this._$parent = parent;
  }
  get parentNode() {
    return this._$parent.parentNode;
  }
  get _$isConnected() {
    return this._$parent._$isConnected;
  }
  _clone(options) {
    const { el: { content }, parts } = this._$template;
    const fragment = (options?.creationScope ?? d).importNode(content, true);
    walker.currentNode = fragment;
    let node = walker.nextNode();
    let nodeIndex = 0;
    let partIndex = 0;
    let templatePart = parts[0];
    while (templatePart !== undefined) {
      if (nodeIndex === templatePart.index) {
        let part;
        if (templatePart.type === CHILD_PART) {
          part = new ChildPart(node, node.nextSibling, this, options);
        } else if (templatePart.type === ATTRIBUTE_PART) {
          part = new templatePart.ctor(node, templatePart.name, templatePart.strings, this, options);
        } else if (templatePart.type === ELEMENT_PART) {
          part = new ElementPart(node, this, options);
        }
        this._$parts.push(part);
        templatePart = parts[++partIndex];
      }
      if (nodeIndex !== templatePart?.index) {
        node = walker.nextNode();
        nodeIndex++;
      }
    }
    walker.currentNode = d;
    return fragment;
  }
  _update(values) {
    let i = 0;
    for (const part of this._$parts) {
      if (part !== undefined) {
        debugLogEvent2 && debugLogEvent2({
          kind: "set part",
          part,
          value: values[i],
          valueIndex: i,
          values,
          templateInstance: this
        });
        if (part.strings !== undefined) {
          part._$setValue(values, part, i);
          i += part.strings.length - 2;
        } else {
          part._$setValue(values[i]);
        }
      }
      i++;
    }
  }
}

class ChildPart {
  get _$isConnected() {
    return this._$parent?._$isConnected ?? this.__isConnected;
  }
  constructor(startNode, endNode, parent, options) {
    this.type = CHILD_PART;
    this._$committedValue = nothing;
    this._$disconnectableChildren = undefined;
    this._$startNode = startNode;
    this._$endNode = endNode;
    this._$parent = parent;
    this.options = options;
    this.__isConnected = options?.isConnected ?? true;
    if (ENABLE_EXTRA_SECURITY_HOOKS) {
      this._textSanitizer = undefined;
    }
  }
  get parentNode() {
    let parentNode = wrap(this._$startNode).parentNode;
    const parent = this._$parent;
    if (parent !== undefined && parentNode?.nodeType === 11) {
      parentNode = parent.parentNode;
    }
    return parentNode;
  }
  get startNode() {
    return this._$startNode;
  }
  get endNode() {
    return this._$endNode;
  }
  _$setValue(value, directiveParent = this) {
    if (DEV_MODE2 && this.parentNode === null) {
      throw new Error(`This \`ChildPart\` has no \`parentNode\` and therefore cannot accept a value. This likely means the element containing the part was manipulated in an unsupported way outside of Lit's control such that the part's marker nodes were ejected from DOM. For example, setting the element's \`innerHTML\` or \`textContent\` can do this.`);
    }
    value = resolveDirective(this, value, directiveParent);
    if (isPrimitive(value)) {
      if (value === nothing || value == null || value === "") {
        if (this._$committedValue !== nothing) {
          debugLogEvent2 && debugLogEvent2({
            kind: "commit nothing to child",
            start: this._$startNode,
            end: this._$endNode,
            parent: this._$parent,
            options: this.options
          });
          this._$clear();
        }
        this._$committedValue = nothing;
      } else if (value !== this._$committedValue && value !== noChange) {
        this._commitText(value);
      }
    } else if (value["_$litType$"] !== undefined) {
      this._commitTemplateResult(value);
    } else if (value.nodeType !== undefined) {
      if (DEV_MODE2 && this.options?.host === value) {
        this._commitText(`[probable mistake: rendered a template's host in itself ` + `(commonly caused by writing \${this} in a template]`);
        console.warn(`Attempted to render the template host`, value, `inside itself. This is almost always a mistake, and in dev mode `, `we render some warning text. In production however, we'll `, `render it, which will usually result in an error, and sometimes `, `in the element disappearing from the DOM.`);
        return;
      }
      this._commitNode(value);
    } else if (isIterable(value)) {
      this._commitIterable(value);
    } else {
      this._commitText(value);
    }
  }
  _insert(node) {
    return wrap(wrap(this._$startNode).parentNode).insertBefore(node, this._$endNode);
  }
  _commitNode(value) {
    if (this._$committedValue !== value) {
      this._$clear();
      if (ENABLE_EXTRA_SECURITY_HOOKS && sanitizerFactoryInternal !== noopSanitizer) {
        const parentNodeName = this._$startNode.parentNode?.nodeName;
        if (parentNodeName === "STYLE" || parentNodeName === "SCRIPT") {
          let message = "Forbidden";
          if (DEV_MODE2) {
            if (parentNodeName === "STYLE") {
              message = `Lit does not support binding inside style nodes. ` + `This is a security risk, as style injection attacks can ` + `exfiltrate data and spoof UIs. ` + `Consider instead using css\`...\` literals ` + `to compose styles, and do dynamic styling with ` + `css custom properties, ::parts, <slot>s, ` + `and by mutating the DOM rather than stylesheets.`;
            } else {
              message = `Lit does not support binding inside script nodes. ` + `This is a security risk, as it could allow arbitrary ` + `code execution.`;
            }
          }
          throw new Error(message);
        }
      }
      debugLogEvent2 && debugLogEvent2({
        kind: "commit node",
        start: this._$startNode,
        parent: this._$parent,
        value,
        options: this.options
      });
      this._$committedValue = this._insert(value);
    }
  }
  _commitText(value) {
    if (this._$committedValue !== nothing && isPrimitive(this._$committedValue)) {
      const node = wrap(this._$startNode).nextSibling;
      if (ENABLE_EXTRA_SECURITY_HOOKS) {
        if (this._textSanitizer === undefined) {
          this._textSanitizer = createSanitizer(node, "data", "property");
        }
        value = this._textSanitizer(value);
      }
      debugLogEvent2 && debugLogEvent2({
        kind: "commit text",
        node,
        value,
        options: this.options
      });
      node.data = value;
    } else {
      if (ENABLE_EXTRA_SECURITY_HOOKS) {
        const textNode = d.createTextNode("");
        this._commitNode(textNode);
        if (this._textSanitizer === undefined) {
          this._textSanitizer = createSanitizer(textNode, "data", "property");
        }
        value = this._textSanitizer(value);
        debugLogEvent2 && debugLogEvent2({
          kind: "commit text",
          node: textNode,
          value,
          options: this.options
        });
        textNode.data = value;
      } else {
        this._commitNode(d.createTextNode(value));
        debugLogEvent2 && debugLogEvent2({
          kind: "commit text",
          node: wrap(this._$startNode).nextSibling,
          value,
          options: this.options
        });
      }
    }
    this._$committedValue = value;
  }
  _commitTemplateResult(result) {
    const { values, ["_$litType$"]: type } = result;
    const template = typeof type === "number" ? this._$getTemplate(result) : (type.el === undefined && (type.el = Template.createElement(trustFromTemplateString(type.h, type.h[0]), this.options)), type);
    if (this._$committedValue?._$template === template) {
      debugLogEvent2 && debugLogEvent2({
        kind: "template updating",
        template,
        instance: this._$committedValue,
        parts: this._$committedValue._$parts,
        options: this.options,
        values
      });
      this._$committedValue._update(values);
    } else {
      const instance = new TemplateInstance(template, this);
      const fragment = instance._clone(this.options);
      debugLogEvent2 && debugLogEvent2({
        kind: "template instantiated",
        template,
        instance,
        parts: instance._$parts,
        options: this.options,
        fragment,
        values
      });
      instance._update(values);
      debugLogEvent2 && debugLogEvent2({
        kind: "template instantiated and updated",
        template,
        instance,
        parts: instance._$parts,
        options: this.options,
        fragment,
        values
      });
      this._commitNode(fragment);
      this._$committedValue = instance;
    }
  }
  _$getTemplate(result) {
    let template = templateCache.get(result.strings);
    if (template === undefined) {
      templateCache.set(result.strings, template = new Template(result));
    }
    return template;
  }
  _commitIterable(value) {
    if (!isArray(this._$committedValue)) {
      this._$committedValue = [];
      this._$clear();
    }
    const itemParts = this._$committedValue;
    let partIndex = 0;
    let itemPart;
    for (const item of value) {
      if (partIndex === itemParts.length) {
        itemParts.push(itemPart = new ChildPart(this._insert(createMarker()), this._insert(createMarker()), this, this.options));
      } else {
        itemPart = itemParts[partIndex];
      }
      itemPart._$setValue(item);
      partIndex++;
    }
    if (partIndex < itemParts.length) {
      this._$clear(itemPart && wrap(itemPart._$endNode).nextSibling, partIndex);
      itemParts.length = partIndex;
    }
  }
  _$clear(start = wrap(this._$startNode).nextSibling, from) {
    this._$notifyConnectionChanged?.(false, true, from);
    while (start !== this._$endNode) {
      const n = wrap(start).nextSibling;
      wrap(start).remove();
      start = n;
    }
  }
  setConnected(isConnected) {
    if (this._$parent === undefined) {
      this.__isConnected = isConnected;
      this._$notifyConnectionChanged?.(isConnected);
    } else if (DEV_MODE2) {
      throw new Error("part.setConnected() may only be called on a " + "RootPart returned from render().");
    }
  }
}

class AttributePart {
  get tagName() {
    return this.element.tagName;
  }
  get _$isConnected() {
    return this._$parent._$isConnected;
  }
  constructor(element, name, strings, parent, options) {
    this.type = ATTRIBUTE_PART;
    this._$committedValue = nothing;
    this._$disconnectableChildren = undefined;
    this.element = element;
    this.name = name;
    this._$parent = parent;
    this.options = options;
    if (strings.length > 2 || strings[0] !== "" || strings[1] !== "") {
      this._$committedValue = new Array(strings.length - 1).fill(new String);
      this.strings = strings;
    } else {
      this._$committedValue = nothing;
    }
    if (ENABLE_EXTRA_SECURITY_HOOKS) {
      this._sanitizer = undefined;
    }
  }
  _$setValue(value, directiveParent = this, valueIndex, noCommit) {
    const strings = this.strings;
    let change = false;
    if (strings === undefined) {
      value = resolveDirective(this, value, directiveParent, 0);
      change = !isPrimitive(value) || value !== this._$committedValue && value !== noChange;
      if (change) {
        this._$committedValue = value;
      }
    } else {
      const values = value;
      value = strings[0];
      let i, v;
      for (i = 0;i < strings.length - 1; i++) {
        v = resolveDirective(this, values[valueIndex + i], directiveParent, i);
        if (v === noChange) {
          v = this._$committedValue[i];
        }
        change ||= !isPrimitive(v) || v !== this._$committedValue[i];
        if (v === nothing) {
          value = nothing;
        } else if (value !== nothing) {
          value += (v ?? "") + strings[i + 1];
        }
        this._$committedValue[i] = v;
      }
    }
    if (change && !noCommit) {
      this._commitValue(value);
    }
  }
  _commitValue(value) {
    if (value === nothing) {
      wrap(this.element).removeAttribute(this.name);
    } else {
      if (ENABLE_EXTRA_SECURITY_HOOKS) {
        if (this._sanitizer === undefined) {
          this._sanitizer = sanitizerFactoryInternal(this.element, this.name, "attribute");
        }
        value = this._sanitizer(value ?? "");
      }
      debugLogEvent2 && debugLogEvent2({
        kind: "commit attribute",
        element: this.element,
        name: this.name,
        value,
        options: this.options
      });
      wrap(this.element).setAttribute(this.name, value ?? "");
    }
  }
}

class PropertyPart extends AttributePart {
  constructor() {
    super(...arguments);
    this.type = PROPERTY_PART;
  }
  _commitValue(value) {
    if (ENABLE_EXTRA_SECURITY_HOOKS) {
      if (this._sanitizer === undefined) {
        this._sanitizer = sanitizerFactoryInternal(this.element, this.name, "property");
      }
      value = this._sanitizer(value);
    }
    debugLogEvent2 && debugLogEvent2({
      kind: "commit property",
      element: this.element,
      name: this.name,
      value,
      options: this.options
    });
    this.element[this.name] = value === nothing ? undefined : value;
  }
}

class BooleanAttributePart extends AttributePart {
  constructor() {
    super(...arguments);
    this.type = BOOLEAN_ATTRIBUTE_PART;
  }
  _commitValue(value) {
    debugLogEvent2 && debugLogEvent2({
      kind: "commit boolean attribute",
      element: this.element,
      name: this.name,
      value: !!(value && value !== nothing),
      options: this.options
    });
    wrap(this.element).toggleAttribute(this.name, !!value && value !== nothing);
  }
}

class EventPart extends AttributePart {
  constructor(element, name, strings, parent, options) {
    super(element, name, strings, parent, options);
    this.type = EVENT_PART;
    if (DEV_MODE2 && this.strings !== undefined) {
      throw new Error(`A \`<${element.localName}>\` has a \`@${name}=...\` listener with ` + "invalid content. Event listeners in templates must have exactly " + "one expression and no surrounding text.");
    }
  }
  _$setValue(newListener, directiveParent = this) {
    newListener = resolveDirective(this, newListener, directiveParent, 0) ?? nothing;
    if (newListener === noChange) {
      return;
    }
    const oldListener = this._$committedValue;
    const shouldRemoveListener = newListener === nothing && oldListener !== nothing || newListener.capture !== oldListener.capture || newListener.once !== oldListener.once || newListener.passive !== oldListener.passive;
    const shouldAddListener = newListener !== nothing && (oldListener === nothing || shouldRemoveListener);
    debugLogEvent2 && debugLogEvent2({
      kind: "commit event listener",
      element: this.element,
      name: this.name,
      value: newListener,
      options: this.options,
      removeListener: shouldRemoveListener,
      addListener: shouldAddListener,
      oldListener
    });
    if (shouldRemoveListener) {
      this.element.removeEventListener(this.name, this, oldListener);
    }
    if (shouldAddListener) {
      this.element.addEventListener(this.name, this, newListener);
    }
    this._$committedValue = newListener;
  }
  handleEvent(event) {
    if (typeof this._$committedValue === "function") {
      this._$committedValue.call(this.options?.host ?? this.element, event);
    } else {
      this._$committedValue.handleEvent(event);
    }
  }
}

class ElementPart {
  constructor(element, parent, options) {
    this.element = element;
    this.type = ELEMENT_PART;
    this._$disconnectableChildren = undefined;
    this._$parent = parent;
    this.options = options;
  }
  get _$isConnected() {
    return this._$parent._$isConnected;
  }
  _$setValue(value) {
    debugLogEvent2 && debugLogEvent2({
      kind: "commit to element binding",
      element: this.element,
      value,
      options: this.options
    });
    resolveDirective(this, value);
  }
}
var polyfillSupport2 = DEV_MODE2 ? global3.litHtmlPolyfillSupportDevMode : global3.litHtmlPolyfillSupport;
polyfillSupport2?.(Template, ChildPart);
(global3.litHtmlVersions ??= []).push("3.3.3");
if (DEV_MODE2 && global3.litHtmlVersions.length > 1) {
  queueMicrotask(() => {
    issueWarning2("multiple-versions", `Multiple versions of Lit loaded. ` + `Loading multiple versions is not recommended.`);
  });
}
var render = (value, container, options) => {
  if (DEV_MODE2 && container == null) {
    throw new TypeError(`The container to render into may not be ${container}`);
  }
  const renderId = DEV_MODE2 ? debugLogRenderId++ : 0;
  const partOwnerNode = options?.renderBefore ?? container;
  let part = partOwnerNode["_$litPart$"];
  debugLogEvent2 && debugLogEvent2({
    kind: "begin render",
    id: renderId,
    value,
    container,
    options,
    part
  });
  if (part === undefined) {
    const endNode = options?.renderBefore ?? null;
    partOwnerNode["_$litPart$"] = part = new ChildPart(container.insertBefore(createMarker(), endNode), endNode, undefined, options ?? {});
  }
  part._$setValue(value);
  debugLogEvent2 && debugLogEvent2({
    kind: "end render",
    id: renderId,
    value,
    container,
    options,
    part
  });
  return part;
};
if (ENABLE_EXTRA_SECURITY_HOOKS) {
  render.setSanitizer = setSanitizer;
  render.createSanitizer = createSanitizer;
  if (DEV_MODE2) {
    render._testOnlyClearSanitizerFactoryDoNotCallOrElse = _testOnlyClearSanitizerFactoryDoNotCallOrElse;
  }
}

// node_modules/lit-element/development/lit-element.js
var JSCompiler_renameProperty2 = (prop, _obj) => prop;
var DEV_MODE3 = true;
var global4 = globalThis;
var issueWarning3;
if (DEV_MODE3) {
  global4.litIssuedWarnings ??= new Set;
  issueWarning3 = (code, warning) => {
    warning += ` See https://lit.dev/msg/${code} for more information.`;
    if (!global4.litIssuedWarnings.has(warning) && !global4.litIssuedWarnings.has(code)) {
      console.warn(warning);
      global4.litIssuedWarnings.add(warning);
    }
  };
}

class LitElement extends ReactiveElement {
  constructor() {
    super(...arguments);
    this.renderOptions = { host: this };
    this.__childPart = undefined;
  }
  createRenderRoot() {
    const renderRoot = super.createRenderRoot();
    this.renderOptions.renderBefore ??= renderRoot.firstChild;
    return renderRoot;
  }
  update(changedProperties) {
    const value = this.render();
    if (!this.hasUpdated) {
      this.renderOptions.isConnected = this.isConnected;
    }
    super.update(changedProperties);
    this.__childPart = render(value, this.renderRoot, this.renderOptions);
  }
  connectedCallback() {
    super.connectedCallback();
    this.__childPart?.setConnected(true);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.__childPart?.setConnected(false);
  }
  render() {
    return noChange;
  }
}
LitElement["_$litElement$"] = true;
LitElement[JSCompiler_renameProperty2("finalized", LitElement)] = true;
global4.litElementHydrateSupport?.({ LitElement });
var polyfillSupport3 = DEV_MODE3 ? global4.litElementPolyfillSupportDevMode : global4.litElementPolyfillSupport;
polyfillSupport3?.({ LitElement });
(global4.litElementVersions ??= []).push("4.2.2");
if (DEV_MODE3 && global4.litElementVersions.length > 1) {
  queueMicrotask(() => {
    issueWarning3("multiple-versions", `Multiple versions of Lit loaded. Loading multiple versions ` + `is not recommended.`);
  });
}
// node_modules/lit-html/development/directive.js
var PartType = {
  ATTRIBUTE: 1,
  CHILD: 2,
  PROPERTY: 3,
  BOOLEAN_ATTRIBUTE: 4,
  EVENT: 5,
  ELEMENT: 6
};
var directive = (c) => (...values) => ({
  ["_$litDirective$"]: c,
  values
});

class Directive {
  constructor(_partInfo) {}
  get _$isConnected() {
    return this._$parent._$isConnected;
  }
  _$initialize(part, parent, attributeIndex) {
    this.__part = part;
    this._$parent = parent;
    this.__attributeIndex = attributeIndex;
  }
  _$resolve(part, props) {
    return this.update(part, props);
  }
  update(_part, props) {
    return this.render(...props);
  }
}

// node_modules/lit-html/development/directives/unsafe-html.js
var HTML_RESULT2 = 1;

class UnsafeHTMLDirective extends Directive {
  constructor(partInfo) {
    super(partInfo);
    this._value = nothing;
    if (partInfo.type !== PartType.CHILD) {
      throw new Error(`${this.constructor.directiveName}() can only be used in child bindings`);
    }
  }
  render(value) {
    if (value === nothing || value == null) {
      this._templateResult = undefined;
      return this._value = value;
    }
    if (value === noChange) {
      return value;
    }
    if (typeof value != "string") {
      throw new Error(`${this.constructor.directiveName}() called with a non-string value`);
    }
    if (value === this._value) {
      return this._templateResult;
    }
    this._value = value;
    const strings = [value];
    strings.raw = strings;
    return this._templateResult = {
      ["_$litType$"]: this.constructor.resultType,
      strings,
      values: []
    };
  }
}
UnsafeHTMLDirective.directiveName = "unsafeHTML";
UnsafeHTMLDirective.resultType = HTML_RESULT2;
var unsafeHTML = directive(UnsafeHTMLDirective);
// src/frontend/components/base.ts
var ICONS = {
  "chevron-down": `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  "chevron-right": `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
  attach: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
  mic: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  send: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`,
  logout: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  wrench: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  monitor: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  eye: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>`,
  activity: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>`,
  terminal: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  network: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><line x1="7" y1="11.5" x2="17" y2="6.5"/><line x1="7" y1="12.5" x2="17" y2="17.5"/></svg>`,
  signal: `<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><ellipse cx="24" cy="24" rx="20" ry="7" stroke="currentColor" stroke-width="0.5" opacity="0.15"/><ellipse cx="24" cy="24" rx="13" ry="4.5" stroke="currentColor" stroke-width="0.5" opacity="0.3"/><ellipse cx="24" cy="24" rx="7" ry="2.5" stroke="currentColor" stroke-width="0.5" opacity="0.5"/><circle cx="24" cy="24" r="1.5" fill="currentColor" opacity="0.9"/></svg>`,
  file: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  waterfall: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`
};
function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function tsStr(timestamp) {
  return new Date(timestamp).toISOString().slice(11, 23);
}

class RorschachBase extends LitElement {
  renderIcon(name) {
    const svg2 = ICONS[name];
    if (!svg2)
      return html``;
    return html`${unsafeHTML(svg2)}`;
  }
}
// node_modules/@lit/reactive-element/development/decorators/custom-element.js
var customElement = (tagName) => (classOrTarget, context) => {
  if (context !== undefined) {
    context.addInitializer(() => {
      customElements.define(tagName, classOrTarget);
    });
  } else {
    customElements.define(tagName, classOrTarget);
  }
};
// node_modules/@lit/reactive-element/development/decorators/property.js
var DEV_MODE4 = true;
var issueWarning4;
if (DEV_MODE4) {
  globalThis.litIssuedWarnings ??= new Set;
  issueWarning4 = (code, warning) => {
    warning += ` See https://lit.dev/msg/${code} for more information.`;
    if (!globalThis.litIssuedWarnings.has(warning) && !globalThis.litIssuedWarnings.has(code)) {
      console.warn(warning);
      globalThis.litIssuedWarnings.add(warning);
    }
  };
}
var legacyProperty = (options, proto, name) => {
  const hasOwnProperty = proto.hasOwnProperty(name);
  proto.constructor.createProperty(name, options);
  return hasOwnProperty ? Object.getOwnPropertyDescriptor(proto, name) : undefined;
};
var defaultPropertyDeclaration2 = {
  attribute: true,
  type: String,
  converter: defaultConverter,
  reflect: false,
  hasChanged: notEqual
};
var standardProperty = (options = defaultPropertyDeclaration2, target, context) => {
  const { kind, metadata } = context;
  if (DEV_MODE4 && metadata == null) {
    issueWarning4("missing-class-metadata", `The class ${target} is missing decorator metadata. This ` + `could mean that you're using a compiler that supports decorators ` + `but doesn't support decorator metadata, such as TypeScript 5.1. ` + `Please update your compiler.`);
  }
  let properties = globalThis.litPropertyMetadata.get(metadata);
  if (properties === undefined) {
    globalThis.litPropertyMetadata.set(metadata, properties = new Map);
  }
  if (kind === "setter") {
    options = Object.create(options);
    options.wrapped = true;
  }
  properties.set(context.name, options);
  if (kind === "accessor") {
    const { name } = context;
    return {
      set(v) {
        const oldValue = target.get.call(this);
        target.set.call(this, v);
        this.requestUpdate(name, oldValue, options, true, v);
      },
      init(v) {
        if (v !== undefined) {
          this._$changeProperty(name, undefined, options, v);
        }
        return v;
      }
    };
  } else if (kind === "setter") {
    const { name } = context;
    return function(value) {
      const oldValue = this[name];
      target.call(this, value);
      this.requestUpdate(name, oldValue, options, true, value);
    };
  }
  throw new Error(`Unsupported decorator location: ${kind}`);
};
function property(options) {
  return (protoOrTarget, nameOrContext) => {
    return typeof nameOrContext === "object" ? standardProperty(options, protoOrTarget, nameOrContext) : legacyProperty(options, protoOrTarget, nameOrContext);
  };
}
// node_modules/@lit/reactive-element/development/decorators/state.js
function state(options) {
  return property({
    ...options,
    state: true,
    attribute: false
  });
}
// node_modules/@lit/reactive-element/development/decorators/base.js
var desc = (obj, name, descriptor) => {
  descriptor.configurable = true;
  descriptor.enumerable = true;
  if (Reflect.decorate && typeof name !== "object") {
    Object.defineProperty(obj, name, descriptor);
  }
  return descriptor;
};

// node_modules/@lit/reactive-element/development/decorators/query.js
var DEV_MODE5 = true;
var issueWarning5;
if (DEV_MODE5) {
  globalThis.litIssuedWarnings ??= new Set;
  issueWarning5 = (code, warning) => {
    warning += code ? ` See https://lit.dev/msg/${code} for more information.` : "";
    if (!globalThis.litIssuedWarnings.has(warning) && !globalThis.litIssuedWarnings.has(code)) {
      console.warn(warning);
      globalThis.litIssuedWarnings.add(warning);
    }
  };
}
function query(selector, cache) {
  return (protoOrTarget, nameOrContext, descriptor) => {
    const doQuery = (el) => {
      const result = el.renderRoot?.querySelector(selector) ?? null;
      if (DEV_MODE5 && result === null && cache && !el.hasUpdated) {
        const name = typeof nameOrContext === "object" ? nameOrContext.name : nameOrContext;
        issueWarning5("", `@query'd field ${JSON.stringify(String(name))} with the 'cache' ` + `flag set for selector '${selector}' has been accessed before ` + `the first update and returned null. This is expected if the ` + `renderRoot tree has not been provided beforehand (e.g. via ` + `Declarative Shadow DOM). Therefore the value hasn't been cached.`);
      }
      return result;
    };
    if (cache) {
      const { get, set } = typeof nameOrContext === "object" ? protoOrTarget : descriptor ?? (() => {
        const key = DEV_MODE5 ? Symbol(`${String(nameOrContext)} (@query() cache)`) : Symbol();
        return {
          get() {
            return this[key];
          },
          set(v) {
            this[key] = v;
          }
        };
      })();
      return desc(protoOrTarget, nameOrContext, {
        get() {
          let result = get.call(this);
          if (result === undefined) {
            result = doQuery(this);
            if (result !== null || this.hasUpdated) {
              set.call(this, result);
            }
          }
          return result;
        }
      });
    } else {
      return desc(protoOrTarget, nameOrContext, {
        get() {
          return doQuery(this);
        }
      });
    }
  };
}
// src/frontend/components/r-icon.ts
class RIcon extends RorschachBase {
  constructor() {
    super(...arguments);
    this.name = "";
    this.size = "md";
  }
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: inherit;
      line-height: 0;
    }
    :host([size="sm"]) { width: 10px; height: 10px; }
    :host([size="md"]) { width: 15px; height: 15px; }
    :host([size="lg"]) { width: 28px; height: 28px; }
    :host([size="xl"]) { width: 48px; height: 48px; }
    :host(:not([size])) { width: 15px; height: 15px; }
    svg { width: 100%; height: 100%; }
  `;
  render() {
    return this.renderIcon(this.name);
  }
}
__legacyDecorateClassTS([
  property({ type: String })
], RIcon.prototype, "name", undefined);
__legacyDecorateClassTS([
  property({ type: String })
], RIcon.prototype, "size", undefined);
RIcon = __legacyDecorateClassTS([
  customElement("r-icon")
], RIcon);
// src/frontend/components/r-badge.ts
class RBadge extends RorschachBase {
  constructor() {
    super(...arguments);
    this.level = "";
    this.variant = "";
    this.status = "";
  }
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      font-size: 0.62rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-align: center;
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
      font-family: var(--font-mono, monospace);
      white-space: nowrap;
    }
    :host([level="debug"]) { color: var(--log-debug, #3d6878); }
    :host([level="info"])  { color: var(--log-info, #5ba0b8); }
    :host([level="warn"])  { color: var(--log-warn, #c4843a); }
    :host([level="error"]) { color: var(--log-error, #e06030); }

    :host([variant="actor"]) {
      font-size: 0.6rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      padding: 0.15rem 0.5rem;
    }
    :host([variant="actor"][status="running"]) { color: var(--green, #39e8a0); background: rgba(69, 196, 154, 0.1); }
    :host([variant="actor"][status="stopped"]) { color: var(--text-dim, #3d6878); background: rgba(255,255,255,0.04); }
    :host([variant="actor"][status="error"])   { color: var(--error, #e06030); background: rgba(201, 95, 82, 0.1); }
  `;
  render() {
    return html`<slot></slot>`;
  }
}
__legacyDecorateClassTS([
  property({ type: String })
], RBadge.prototype, "level", undefined);
__legacyDecorateClassTS([
  property({ type: String })
], RBadge.prototype, "variant", undefined);
__legacyDecorateClassTS([
  property({ type: String })
], RBadge.prototype, "status", undefined);
RBadge = __legacyDecorateClassTS([
  customElement("r-badge")
], RBadge);
// src/frontend/store.ts
var state3 = {
  isConnected: false,
  isWaiting: false,
  currentUserId: null,
  currentUserRoles: [],
  agents: [],
  currentMode: "",
  currentModeDisplayName: "",
  topics: [],
  actors: [],
  logs: [],
  ws: null
};
var listeners = new Map;
function notify(key, value, prev) {
  const set = listeners.get(key);
  if (set) {
    for (const cb of set) {
      try {
        cb(value, prev);
      } catch (e) {
        console.error("Store listener error:", e);
      }
    }
  }
}
var store = {
  get(key) {
    return state3[key];
  },
  set(key, value) {
    const prev = state3[key];
    state3[key] = value;
    if (prev !== value)
      notify(key, value, prev);
  },
  subscribe(key, callback) {
    if (!listeners.has(key))
      listeners.set(key, new Set);
    listeners.get(key).add(callback);
    callback(state3[key], state3[key]);
    return () => {
      const set = listeners.get(key);
      if (set) {
        set.delete(callback);
        if (set.size === 0)
          listeners.delete(key);
      }
    };
  },
  getState() {
    return state3;
  }
};

// src/frontend/components/r-status-dot.ts
class RStatusDot extends RorschachBase {
  constructor() {
    super(...arguments);
    this.status = "disconnected";
    this.label = "connecting…";
  }
  _unsub;
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
    }

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--muted, #215060);
      transition: background 0.4s, box-shadow 0.4s;
      flex-shrink: 0;
    }

    :host([status="connected"]) .dot {
      background: var(--accent, #00c4d4);
      box-shadow: 0 0 8px rgba(0,196,212,0.5);
      animation: signalPulse 2.5s ease-out infinite;
    }

    :host([status="disconnected"]) .dot {
      background: var(--error, #e06030);
      box-shadow: 0 0 6px rgba(224,96,48,0.4);
    }

    :host([status="running"]) .dot {
      background: var(--green, #39e8a0);
      box-shadow: 0 0 4px var(--green-glow, rgba(57, 232, 160, 0.2));
    }

    :host([status="stopped"]) .dot {
      background: var(--muted, #215060);
    }

    :host([status="error"]) .dot {
      background: var(--error, #e06030);
    }

    .label {
      font-size: 0.68rem;
      font-weight: 500;
      color: var(--text-dim, #3d6878);
      letter-spacing: 0.06em;
      white-space: nowrap;
    }

    @keyframes signalPulse {
      0%   { box-shadow: 0 0 0 0 rgba(0,196,212,0.5); }
      70%  { box-shadow: 0 0 0 6px rgba(0,196,212,0); }
      100% { box-shadow: 0 0 0 0 rgba(0,196,212,0); }
    }
  `;
  connectedCallback() {
    super.connectedCallback();
    this._unsub = store.subscribe("isConnected", (connected) => {
      this.status = connected ? "connected" : "disconnected";
      this.label = connected ? "connected" : "reconnecting…";
    });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._unsub) {
      this._unsub();
    }
  }
  render() {
    return html`
      <span class="dot"></span>
      ${this.label ? html`<span class="label">${this.label}</span>` : ""}
    `;
  }
}
__legacyDecorateClassTS([
  property({ type: String, reflect: true })
], RStatusDot.prototype, "status", undefined);
__legacyDecorateClassTS([
  property({ type: String })
], RStatusDot.prototype, "label", undefined);
RStatusDot = __legacyDecorateClassTS([
  customElement("r-status-dot")
], RStatusDot);
// src/frontend/components/r-empty-state.ts
class REmptyState extends RorschachBase {
  constructor() {
    super(...arguments);
    this.name = "";
    this.icon = "";
    this.text = "";
    this.subtext = "";
    this.variant = "";
  }
  static styles = css`
    :host {
      display: flex;
      flex: 1;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
      pointer-events: none;
      user-select: none;
      padding: 2rem;
    }

    .icon {
      color: var(--accent, #00c4d4);
      opacity: 0.35;
      line-height: 0;
    }

    :host([variant="panel"]) .icon { opacity: 0.1; }

    .text {
      font-size: 0.65rem;
      font-family: var(--font-mono, monospace);
      font-weight: 300;
      color: var(--text-dim, #3d6878);
    }

    .text::after {
      content: '_';
      animation: blink 1.1s step-end infinite;
    }

    :host([variant="chat"]) {
      animation: emptyFade 0.6s ease both;
    }

    :host([variant="chat"]) .text {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      font-family: var(--font-ui, sans-serif);
    }

    @keyframes emptyFade {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .subtext {
      font-size: 0.68rem;
      color: var(--text-dim, #3d6878);
      opacity: 0.5;
      font-family: var(--font-mono, monospace);
      font-weight: 300;
    }

    .subtext::after {
      content: '_';
      animation: blink 1.1s step-end infinite;
    }

    @keyframes blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0; }
    }
  `;
  render() {
    return html`
      ${this.name ? html`<span class="icon">${this.renderIcon(this.name)}</span>` : this.icon ? html`<span class="icon">${unsafeHTML(this.icon)}</span>` : ""}
      ${this.text ? html`<span class="text">${this.text}</span>` : ""}
      ${this.subtext ? html`<span class="subtext">${this.subtext}</span>` : ""}
    `;
  }
}
__legacyDecorateClassTS([
  property({ type: String })
], REmptyState.prototype, "name", undefined);
__legacyDecorateClassTS([
  property({ type: String })
], REmptyState.prototype, "icon", undefined);
__legacyDecorateClassTS([
  property({ type: String })
], REmptyState.prototype, "text", undefined);
__legacyDecorateClassTS([
  property({ type: String })
], REmptyState.prototype, "subtext", undefined);
__legacyDecorateClassTS([
  property({ type: String, reflect: true })
], REmptyState.prototype, "variant", undefined);
REmptyState = __legacyDecorateClassTS([
  customElement("r-empty-state")
], REmptyState);
// src/frontend/components/r-tabs.ts
class RTabs extends RorschachBase {
  static styles = css`
    :host {
      display: flex;
      align-items: stretch;
    }

    ::slotted(button) {
      font-size: 0.64rem;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-dim, #3d6878);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 0 1rem;
      cursor: pointer;
      font-family: var(--font-ui, sans-serif);
      transition: color 0.15s, border-color 0.15s;
      position: relative;
      top: 1px;
    }

    ::slotted(button:hover) {
      color: var(--text-mid, #8abccc);
    }

    ::slotted(button.active) {
      color: var(--accent, #00c4d4);
      border-bottom-color: var(--accent, #00c4d4);
    }
  `;
  _handleClick(e) {
    const btn = e.target.closest("button");
    if (!btn)
      return;
    const tabId = btn.dataset.tab || btn.dataset.subtab || btn.dataset.configTab;
    if (!tabId)
      return;
    const allBtns = this.querySelectorAll("button");
    allBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    this.dispatchEvent(new CustomEvent("tab-change", {
      bubbles: true,
      composed: true,
      detail: { tab: tabId }
    }));
  }
  render() {
    return html`<slot @click=${this._handleClick}></slot>`;
  }
}
RTabs = __legacyDecorateClassTS([
  customElement("r-tabs")
], RTabs);
// src/frontend/session.ts
var initialized = false;
function modeLabel(mode, displayName = "") {
  if (displayName)
    return displayName;
  if (!mode)
    return "Mode";
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}
function setMode(mode, displayName = "") {
  store.set("currentMode", mode);
  store.set("currentModeDisplayName", displayName || modeLabel(mode));
}
function handleSessionFrame(msg) {
  if (msg.type === "agents") {
    store.set("agents", Array.isArray(msg.agents) ? msg.agents : []);
  } else if (msg.type === "modeChanged") {
    setMode(msg.mode, msg.displayName);
  } else if (msg.type === "plannerMode") {
    if (msg.active)
      setMode("planner", "Planner");
    else if (store.get("currentMode") === "planner")
      setMode("chatbot", "Chatbot");
  }
}
function switchMode(mode) {
  const ws = store.get("ws");
  if (!mode || mode === store.get("currentMode") || ws?.readyState !== WebSocket.OPEN) {
    return false;
  }
  ws.send(JSON.stringify({ type: "switchMode", mode }));
  return true;
}
function initSession() {
  if (initialized)
    return;
  initialized = true;
  document.addEventListener("ws-message", (event) => handleSessionFrame(event.detail));
}

// src/frontend/components/r-mode-select.ts
class RModeSelect extends RorschachBase {
  constructor() {
    super(...arguments);
    this._agents = [];
    this._currentMode = "";
    this._currentModeDisplayName = "";
    this._isConnected = false;
    this._isWaiting = false;
  }
  _unsubs = [];
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this._unsubs = [
      store.subscribe("agents", (val) => this._agents = val),
      store.subscribe("currentMode", (val) => this._currentMode = val),
      store.subscribe("currentModeDisplayName", (val) => this._currentModeDisplayName = val),
      store.subscribe("isConnected", (val) => this._isConnected = val),
      store.subscribe("isWaiting", (val) => this._isWaiting = val)
    ];
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubs.forEach((unsub) => unsub());
  }
  _modeLabel(mode, displayName = "") {
    if (displayName)
      return displayName;
    if (!mode)
      return "Mode";
    return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
  _handleChange(e) {
    const select = e.target;
    if (switchMode(select.value)) {
      this._isWaiting = true;
    }
  }
  render() {
    const agentList = this._agents.length > 0 ? this._agents : this._currentMode ? [{
      mode: this._currentMode,
      displayName: this._currentModeDisplayName || this._modeLabel(this._currentMode),
      shortDesc: ""
    }] : [];
    const isDisabled = !this._isConnected || this._isWaiting || agentList.length < 2;
    if (agentList.length === 0) {
      return html`
        <label class="mode-select-wrap" for="mode-select">
          <span>mode</span>
          <select id="mode-select" disabled>
            <option value="">loading</option>
          </select>
        </label>
      `;
    }
    return html`
      <label class="mode-select-wrap" for="mode-select">
        <span>mode</span>
        <select id="mode-select" ?disabled=${isDisabled} @change=${this._handleChange}>
          ${agentList.map((agent) => html`
            <option 
              value=${agent.mode} 
              ?selected=${agent.mode === this._currentMode} 
              .title=${agent.shortDesc || ""}
            >
              ${agent.displayName || this._modeLabel(agent.mode)}
            </option>
          `)}
        </select>
      </label>
    `;
  }
}
__legacyDecorateClassTS([
  state()
], RModeSelect.prototype, "_agents", undefined);
__legacyDecorateClassTS([
  state()
], RModeSelect.prototype, "_currentMode", undefined);
__legacyDecorateClassTS([
  state()
], RModeSelect.prototype, "_currentModeDisplayName", undefined);
__legacyDecorateClassTS([
  state()
], RModeSelect.prototype, "_isConnected", undefined);
__legacyDecorateClassTS([
  state()
], RModeSelect.prototype, "_isWaiting", undefined);
RModeSelect = __legacyDecorateClassTS([
  customElement("r-mode-select")
], RModeSelect);
// src/frontend/components/r-topic-list.ts
class RTopicList extends RorschachBase {
  constructor() {
    super(...arguments);
    this.topics = [];
    this._expandedTopics = new Set;
  }
  static styles = css`
    :host {
      display: block;
    }

    .topic-entry {
      margin-bottom: 2px;
    }

    .topic-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.6rem;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--font-mono, monospace);
      font-size: 0.72rem;
      transition: background 0.15s;
    }

    .topic-row:hover {
      background: rgba(0, 196, 212, 0.04);
    }

    .topic-row.topic-group {
      font-weight: 600;
      color: var(--text-mid, #8abccc);
    }

    .tree-chevron {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      color: var(--text-dim, #3d6878);
    }

    .tree-spacer {
      width: 14px;
    }

    .topic-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .topic-sub-count {
      font-size: 0.64rem;
      color: var(--text-dim, #3d6878);
      opacity: 0.7;
    }

    .topic-children, .topic-subscribers {
      margin-left: 1.25rem;
      border-left: 1px solid var(--border-mid, #1a3a4a);
      padding-left: 0.5rem;
      margin-top: 2px;
      margin-bottom: 4px;
    }

    .topic-sub-row {
      font-size: 0.68rem;
      padding: 0.2rem 0;
      color: var(--text-dim, #3d6878);
    }
  `;
  _toggleTopic(topic) {
    if (this._expandedTopics.has(topic)) {
      this._expandedTopics.delete(topic);
    } else {
      this._expandedTopics.add(topic);
    }
    this.requestUpdate();
  }
  _renderEntry(t, label) {
    const displayLabel = label ?? t.topic;
    const isExpanded = this._expandedTopics.has(t.topic);
    const subCount = t.subscribers.length;
    return html`
      <div class="topic-entry">
        <div class="topic-row" @click=${() => subCount > 0 && this._toggleTopic(t.topic)}>
          ${subCount > 0 ? html`<span class="tree-chevron">${this.renderIcon(isExpanded ? "chevron-down" : "chevron-right")}</span>` : html`<span class="tree-spacer"></span>`}
          <span class="topic-name">${displayLabel}</span>
          <span class="topic-sub-count">${subCount}</span>
        </div>
        ${isExpanded && subCount > 0 ? html`
          <div class="topic-subscribers">
            ${t.subscribers.map((s) => html`
              <div class="topic-sub-row"><span class="topic-sub-name">${s}</span></div>
            `)}
          </div>
        ` : ""}
      </div>
    `;
  }
  render() {
    if (this.topics.length === 0) {
      return html`<r-empty-state variant="panel" text="no active topics"></r-empty-state>`;
    }
    const watchTopics = this.topics.filter((t) => t.topic.startsWith("$watch:"));
    const otherTopics = this.topics.filter((t) => !t.topic.startsWith("$watch:"));
    const isGroupExpanded = this._expandedTopics.has("$watch");
    return html`
      ${watchTopics.length > 0 ? html`
        <div class="topic-entry">
          <div class="topic-row topic-group" @click=${() => this._toggleTopic("$watch")}>
            <span class="tree-chevron">${this.renderIcon(isGroupExpanded ? "chevron-down" : "chevron-right")}</span>
            <span class="topic-name">$watch</span>
            <span class="topic-sub-count">${watchTopics.length}</span>
          </div>
          ${isGroupExpanded ? html`
            <div class="topic-children">
              ${watchTopics.map((t) => this._renderEntry(t, t.topic.slice("$watch:".length)))}
            </div>
          ` : ""}
        </div>
      ` : ""}
      ${otherTopics.map((t) => this._renderEntry(t))}
    `;
  }
}
__legacyDecorateClassTS([
  property({ type: Array })
], RTopicList.prototype, "topics", undefined);
__legacyDecorateClassTS([
  state()
], RTopicList.prototype, "_expandedTopics", undefined);
RTopicList = __legacyDecorateClassTS([
  customElement("r-topic-list")
], RTopicList);
// src/frontend/components/r-actor-tree.ts
class RActorTree extends RorschachBase {
  constructor() {
    super(...arguments);
    this.actors = [];
    this._selectedActor = null;
    this._collapsedSet = new Set;
  }
  _actorsMap = {};
  createRenderRoot() {
    return this;
  }
  willUpdate(changedProperties) {
    if (changedProperties.has("actors")) {
      this._actorsMap = {};
      this.actors.forEach((a) => {
        this._actorsMap[a.name] = a;
      });
      if (this._selectedActor && !this._actorsMap[this._selectedActor]) {
        this._selectedActor = null;
      }
    }
  }
  _buildTree(actors) {
    const nodes = {};
    actors.forEach((a) => {
      const parts = a.name.split("/");
      parts.forEach((_, i) => {
        const path = parts.slice(0, i + 1).join("/");
        const label = parts[i];
        if (!nodes[path]) {
          nodes[path] = { label, path, children: [], data: null };
        }
      });
      nodes[a.name].data = a;
    });
    const roots = [];
    Object.values(nodes).forEach((node) => {
      const parts = node.path.split("/");
      if (parts.length === 1) {
        roots.push(node);
      } else {
        const parentPath = parts.slice(0, -1).join("/");
        if (nodes[parentPath]) {
          nodes[parentPath].children.push(node);
        } else {
          roots.push(node);
        }
      }
    });
    const sort = (arr) => {
      arr.sort((a, b) => a.label.localeCompare(b.label));
      arr.forEach((n) => sort(n.children));
      return arr;
    };
    return sort(roots);
  }
  _renderNodes(nodes, depth) {
    return nodes.map((node) => {
      const hasChildren = node.children.length > 0;
      const isCollapsed = this._collapsedSet.has(node.path);
      const isSelected = this._selectedActor === node.path;
      const status = node.data?.status || (hasChildren && !node.data ? null : "running");
      const padLeft = `${0.6 + depth * 1.1}rem`;
      const handleChevronClick = (e) => {
        e.stopPropagation();
        if (this._collapsedSet.has(node.path)) {
          this._collapsedSet.delete(node.path);
        } else {
          this._collapsedSet.add(node.path);
        }
        this.requestUpdate();
      };
      const handleRowClick = () => {
        if (node.data) {
          this._selectedActor = node.path;
          this.dispatchEvent(new CustomEvent("actor-select", {
            bubbles: true,
            composed: true,
            detail: { actor: node.data }
          }));
        } else {
          if (this._collapsedSet.has(node.path)) {
            this._collapsedSet.delete(node.path);
          } else {
            this._collapsedSet.add(node.path);
          }
          this.requestUpdate();
        }
      };
      return html`
        <div class="tree-node">
          <div 
            class="tree-row ${isSelected ? "selected" : ""}" 
            style="padding-left:${padLeft}"
            @click=${handleRowClick}
          >
            ${hasChildren ? html`<span class="tree-chevron" @click=${handleChevronClick}>
                  ${this.renderIcon(isCollapsed ? "chevron-right" : "chevron-down")}
                </span>` : html`<span class="tree-spacer"></span>`}
            
            ${status ? html`<span class="tree-dot ${status}"></span>` : html`<span class="tree-dot-empty"></span>`}
            
            <span class="tree-label">${node.label}</span>
            
            ${node.data ? html`<span class="tree-msg-count">${node.data.messagesProcessed ?? 0}</span>` : ""}
          </div>
          ${hasChildren && !isCollapsed ? html`
            <div class="tree-children">
              ${this._renderNodes(node.children, depth + 1)}
            </div>
          ` : ""}
        </div>
      `;
    });
  }
  updateActors(actors) {
    this.actors = actors;
    return this._selectedActor ? this._actorsMap[this._selectedActor] : null;
  }
  render() {
    const roots = this._buildTree(Object.values(this._actorsMap));
    if (roots.length === 0) {
      return html`<r-empty-state variant="panel" name="monitor" text="awaiting metrics snapshot"></r-empty-state>`;
    }
    return html`${this._renderNodes(roots, 0)}`;
  }
}
__legacyDecorateClassTS([
  property({ type: Array })
], RActorTree.prototype, "actors", undefined);
__legacyDecorateClassTS([
  state()
], RActorTree.prototype, "_selectedActor", undefined);
__legacyDecorateClassTS([
  state()
], RActorTree.prototype, "_collapsedSet", undefined);
RActorTree = __legacyDecorateClassTS([
  customElement("r-actor-tree")
], RActorTree);
// src/frontend/components/r-actor-detail.ts
class RActorDetail extends RorschachBase {
  constructor() {
    super(...arguments);
    this.actor = null;
  }
  createRenderRoot() {
    return this;
  }
  show(actor) {
    this.actor = actor;
  }
  render() {
    if (!this.actor) {
      return html`<r-empty-state variant="panel" name="eye" text="select an actor to inspect"></r-empty-state>`;
    }
    const actor = this.actor;
    const status = actor.status || "running";
    const failed = actor.messagesFailed ?? 0;
    const avg = typeof actor.processingTime?.avg === "number" ? actor.processingTime.avg.toFixed(2) : "—";
    const min = typeof actor.processingTime?.min === "number" ? actor.processingTime.min.toFixed(2) : "—";
    const max = typeof actor.processingTime?.max === "number" ? actor.processingTime.max.toFixed(2) : "—";
    const parts = actor.name.split("/");
    const breadcrumb = parts.map((p, i) => i < parts.length - 1 ? html`<span class="crumb">${p}</span><span class="crumb-sep">/</span>` : html`<span class="crumb active">${p}</span>`);
    const stateSection = actor.state !== undefined && actor.state !== null ? html`
          <div class="detail-section-label">state</div>
          <pre class="detail-state">${JSON.stringify(actor.state, null, 2)}</pre>
        ` : "";
    return html`
      <div class="detail-head">
        <div class="detail-path">${breadcrumb}</div>
        <span class="actor-status ${status}">${status}</span>
      </div>
      <div class="detail-divider"></div>
      <div class="detail-section-label">messages</div>
      <div class="detail-grid">
        <div class="detail-stat">
          <span class="ds-val">${actor.messagesReceived ?? 0}</span>
          <span class="ds-key">received</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val">${actor.messagesProcessed ?? 0}</span>
          <span class="ds-key">processed</span>
        </div>
        <div class="detail-stat ${failed > 0 ? "error" : ""}">
          <span class="ds-val ${failed > 0 ? "error" : ""}">${failed}</span>
          <span class="ds-key">failed</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val">${actor.mailboxSize ?? 0}</span>
          <span class="ds-key">mailbox</span>
        </div>
      </div>
      <div class="detail-section-label">processing time</div>
      <div class="detail-grid three">
        <div class="detail-stat">
          <span class="ds-val sm">${avg} <span class="ds-unit">ms</span></span>
          <span class="ds-key">average</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val sm">${min} <span class="ds-unit">ms</span></span>
          <span class="ds-key">minimum</span>
        </div>
        <div class="detail-stat">
          <span class="ds-val sm">${max} <span class="ds-unit">ms</span></span>
          <span class="ds-key">maximum</span>
        </div>
      </div>
      ${stateSection}
    `;
  }
}
__legacyDecorateClassTS([
  property({ type: Object })
], RActorDetail.prototype, "actor", undefined);
RActorDetail = __legacyDecorateClassTS([
  customElement("r-actor-detail")
], RActorDetail);
// src/frontend/components/r-log-stream.ts
var MAX_LOGS = 500;

class RLogStream extends RorschachBase {
  constructor() {
    super(...arguments);
    this._logs = [];
  }
  createRenderRoot() {
    return this;
  }
  get count() {
    return this._logs.length;
  }
  appendEvent(event) {
    this._logs = [event, ...this._logs].slice(0, MAX_LOGS);
    return this._logs.length;
  }
  clear() {
    this._logs = [];
    return 0;
  }
  render() {
    if (this._logs.length === 0) {
      return html`
        <r-empty-state 
          variant="panel" 
          name="terminal" 
          text="awaiting log events"
        ></r-empty-state>
      `;
    }
    return html`
      ${this._logs.map((event) => {
      const level = event.level || "info";
      const dataStr = event.data !== undefined ? JSON.stringify(event.data) : "";
      return html`
          <div class="log-entry">
            <span class="log-ts">${tsStr(event.timestamp || Date.now())}</span>
            <span class="log-level ${level}">${level.toUpperCase()}</span>
            <span class="log-body">
              <span class="log-source">[${event.source || "?"}]</span>
              <span class="log-msg ${level}">${event.message || ""}</span>
              ${dataStr ? html`<span class="log-data">${dataStr}</span>` : ""}
            </span>
          </div>
        `;
    })}
    `;
  }
}
__legacyDecorateClassTS([
  state()
], RLogStream.prototype, "_logs", undefined);
RLogStream = __legacyDecorateClassTS([
  customElement("r-log-stream")
], RLogStream);
// src/frontend/components/r-tools-list.ts
class RToolsList extends RorschachBase {
  constructor() {
    super(...arguments);
    this._toolsMap = {};
  }
  createRenderRoot() {
    return this;
  }
  register(name, schema) {
    this._toolsMap = { ...this._toolsMap, [name]: schema };
  }
  unregister(name) {
    const next = { ...this._toolsMap };
    delete next[name];
    this._toolsMap = next;
  }
  render() {
    const names = Object.keys(this._toolsMap).sort();
    if (names.length === 0) {
      return html`
        <r-empty-state 
          variant="panel" 
          name="wrench" 
          text="no tools registered"
        ></r-empty-state>
      `;
    }
    return html`
      ${names.map((name) => {
      const desc2 = this._toolsMap[name]?.function?.description ?? "";
      return html`
          <div class="tool-row">
            <span class="tool-name">${name}</span>
            <span class="tool-desc">${desc2}</span>
          </div>
        `;
    })}
    `;
  }
}
__legacyDecorateClassTS([
  state()
], RToolsList.prototype, "_toolsMap", undefined);
RToolsList = __legacyDecorateClassTS([
  customElement("r-tools-list")
], RToolsList);
// src/frontend/components/r-costs-table.ts
function formatTokens(n) {
  if (n >= 1000)
    return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

class RCostsTable extends RorschachBase {
  constructor() {
    super(...arguments);
    this._costsMap = new Map;
  }
  createRenderRoot() {
    return this;
  }
  addUsage(msg) {
    if (!msg.role || !msg.model)
      return;
    const key = `${msg.role}:${msg.model}`;
    const prev = this._costsMap.get(key) ?? {
      role: msg.role,
      model: msg.model,
      inputTokens: 0,
      outputTokens: 0,
      contextWindow: null,
      cost: 0
    };
    this._costsMap.set(key, {
      ...prev,
      inputTokens: prev.inputTokens + (msg.inputTokens ?? 0),
      outputTokens: prev.outputTokens + (msg.outputTokens ?? 0),
      contextWindow: msg.contextWindow ?? prev.contextWindow,
      cost: (prev.cost ?? 0) + (msg.cost ?? 0)
    });
    this.requestUpdate();
  }
  render() {
    if (this._costsMap.size === 0) {
      return html`
        <r-empty-state variant="panel" text="no usage data yet"></r-empty-state>
      `;
    }
    let totalIn = 0, totalOut = 0, totalCost = 0;
    const entries = [...this._costsMap.values()];
    return html`
      <table class="costs-table">
        <thead>
          <tr>
            <th>role</th>
            <th>model</th>
            <th>in</th>
            <th>out</th>
            <th>ctx</th>
            <th>cost</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map((entry) => {
      totalIn += entry.inputTokens;
      totalOut += entry.outputTokens;
      totalCost += entry.cost ?? 0;
      const ctx = entry.contextWindow ? `${Math.round(entry.contextWindow / 1000)}k` : "—";
      const cost = entry.cost != null && entry.cost > 0 ? `$${entry.cost.toFixed(4)}` : "—";
      return html`
              <tr>
                <td>${entry.role}</td>
                <td title=${entry.model}>${entry.model}</td>
                <td>${formatTokens(entry.inputTokens)}</td>
                <td>${formatTokens(entry.outputTokens)}</td>
                <td>${ctx}</td>
                <td>${cost}</td>
              </tr>
            `;
    })}
        </tbody>
        <tfoot>
          <tr>
            <td>total</td>
            <td></td>
            <td>${formatTokens(totalIn)}</td>
            <td>${formatTokens(totalOut)}</td>
            <td></td>
            <td>${totalCost > 0 ? `$${totalCost.toFixed(4)}` : "—"}</td>
          </tr>
        </tfoot>
      </table>
    `;
  }
}
__legacyDecorateClassTS([
  state()
], RCostsTable.prototype, "_costsMap", undefined);
RCostsTable = __legacyDecorateClassTS([
  customElement("r-costs-table")
], RCostsTable);
// src/frontend/components/r-trace-waterfall.ts
var MAX_TRACES = 20;

class RTraceWaterfall extends RorschachBase {
  constructor() {
    super(...arguments);
    this._tracesMap = new Map;
  }
  createRenderRoot() {
    return this;
  }
  get size() {
    return this._tracesMap.size;
  }
  addSpan(span) {
    let record = this._tracesMap.get(span.traceId);
    if (!record) {
      if (this._tracesMap.size >= MAX_TRACES) {
        const oldestId = this._tracesMap.keys().next().value;
        if (oldestId)
          this._tracesMap.delete(oldestId);
      }
      record = { traceId: span.traceId, requestStart: span.timestamp, spans: new Map };
      this._tracesMap.set(span.traceId, record);
    }
    let spanData = record.spans.get(span.spanId);
    if (!spanData) {
      spanData = {
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        actor: span.actor,
        operation: span.operation,
        startTime: span.timestamp,
        status: span.status,
        data: span.data
      };
      record.spans.set(span.spanId, spanData);
    } else {
      spanData.endTime = span.timestamp;
      spanData.durationMs = span.durationMs;
      spanData.status = span.status;
      if (span.data) {
        spanData.data = { ...spanData.data, ...span.data };
      }
    }
    if (span.operation === "request" && (span.status === "done" || span.status === "error")) {
      record.requestDuration = span.durationMs;
      record.requestEnd = span.timestamp;
    }
    this.requestUpdate();
  }
  clear() {
    this._tracesMap.clear();
    this.requestUpdate();
  }
  _computeDepths(spans) {
    const depthMap = new Map;
    const spanMap = new Map(spans.map((s) => [s.spanId, s]));
    const getDepth = (span) => {
      if (depthMap.has(span.spanId))
        return depthMap.get(span.spanId);
      if (!span.parentSpanId) {
        depthMap.set(span.spanId, 0);
        return 0;
      }
      const parent = spanMap.get(span.parentSpanId);
      const d2 = parent ? getDepth(parent) + 1 : 0;
      depthMap.set(span.spanId, d2);
      return d2;
    };
    spans.forEach((s) => getDepth(s));
    return depthMap;
  }
  _renderSpanRow(span, traceStart, totalMs, depth) {
    const offset = Math.max(0, (span.startTime - traceStart) / totalMs * 100);
    const duration = span.durationMs ?? Date.now() - span.startTime;
    const width = Math.max(0.5, Math.min(100 - offset, duration / totalMs * 100));
    const isActive = span.status === "started";
    const isError = span.status === "error";
    const opClass = "op-" + span.operation.replace(/[^a-z0-9]/g, "-");
    const dur = span.durationMs != null ? span.durationMs + "ms" : "…";
    const actorShort = span.actor.split("/").pop() ?? span.actor;
    const opLabel = span.operation === "tool-invoke" && span.data?.toolName ? `tool-invoke · ${span.data.toolName}` : span.operation;
    return html`
      <div class="waterfall-row" style="padding-left:${8 + depth * 12}px">
        <div class="waterfall-label">
          <span class="wf-actor">${actorShort}</span>
          <span class="wf-op">${opLabel}</span>
        </div>
        <div class="waterfall-track">
          <div 
            class="waterfall-bar ${opClass} ${isActive ? "wf-active" : ""} ${isError ? "wf-error" : ""}"
            style="left:${offset.toFixed(1)}%;width:${width.toFixed(1)}%"
          ></div>
        </div>
        <div class="waterfall-dur">${dur}</div>
      </div>
    `;
  }
  _renderTrace(record) {
    const spans = Array.from(record.spans.values());
    const now = Date.now();
    const totalMs = record.requestDuration ?? now - record.requestStart;
    const isLive = !record.requestEnd;
    const depthMap = this._computeDepths(spans);
    const sorted = [...spans].sort((a, b) => a.startTime - b.startTime);
    const rows = sorted.map((s) => this._renderSpanRow(s, record.requestStart, totalMs, depthMap.get(s.spanId) ?? 0));
    const durStr = record.requestDuration != null ? record.requestDuration + "ms" : "…";
    const traceIdShort = record.traceId.slice(-10);
    return html`
      <div class="trace-item ${isLive ? "wf-live" : ""}">
        <div class="trace-header">
          <span class="trace-id">${traceIdShort}</span>
          <span class="trace-dur">${durStr}</span>
          ${isLive ? html`<span class="trace-live-badge">live</span>` : ""}
        </div>
        <div class="trace-waterfall">${rows}</div>
      </div>
    `;
  }
  render() {
    if (this._tracesMap.size === 0) {
      return html`
        <r-empty-state 
          variant="panel" 
          name="waterfall" 
          text="awaiting traces"
        ></r-empty-state>
      `;
    }
    const arr = Array.from(this._tracesMap.values()).reverse();
    return html`${arr.map((r) => this._renderTrace(r))}`;
  }
}
__legacyDecorateClassTS([
  state()
], RTraceWaterfall.prototype, "_tracesMap", undefined);
RTraceWaterfall = __legacyDecorateClassTS([
  customElement("r-trace-waterfall")
], RTraceWaterfall);
// src/frontend/components/r-observe-panel.ts
var CONTROL_BY_TAB = {
  metrics: "metrics-summary",
  logs: "obs-log-controls",
  traces: "obs-traces-controls",
  memory: "obs-memory-controls"
};

class RObservePanel extends RorschachBase {
  constructor() {
    super(...arguments);
    this._activeTab = "metrics";
    this._metrics = { actors: 0, recv: 0, done: 0, fail: 0 };
    this._logCountText = "0 events";
    this._tracesCountText = "0 traces";
    this._memoryStatsText = "";
  }
  createRenderRoot() {
    return this;
  }
  handleMetrics(msg) {
    const event = msg;
    const actors = event.actors || [];
    let totRecv = 0;
    let totDone = 0;
    let totFail = 0;
    actors.forEach((a) => {
      totRecv += a.messagesReceived || 0;
      totDone += a.messagesProcessed || 0;
      totFail += a.messagesFailed || 0;
    });
    if (actors.length > 0) {
      this._metrics = {
        actors: actors.length,
        recv: totRecv,
        done: totDone,
        fail: totFail
      };
      store.set("actors", actors);
    }
    if (this._actorTree) {
      this._actorTree.actors = actors;
    }
    if (this._actorDetail?.actor) {
      const updated = actors.find((a) => a.name === this._actorDetail.actor.name);
      if (updated) {
        this._actorDetail.show(updated);
      }
    }
    if (event.topics) {
      const topics = event.topics;
      store.set("topics", topics);
      if (this._topicList) {
        this._topicList.topics = topics;
      }
    }
  }
  handleLog(msg) {
    const count = this._logStream?.appendEvent(msg) ?? 0;
    this._logCountText = `${count} event${count !== 1 ? "s" : ""}`;
  }
  handleTrace(msg) {
    this._tracesList?.addSpan(msg);
    if (this._activeTab === "traces") {
      this._tracesList?.requestUpdate();
    }
    const size = this._tracesList?.size ?? 0;
    this._tracesCountText = `${size} trace${size !== 1 ? "s" : ""}`;
  }
  handleUsage(msg) {
    this._costsTable?.addUsage(msg);
    if (this._activeTab === "costs") {
      this._costsTable?.requestUpdate();
    }
  }
  handleToolRegistered(msg) {
    this._toolsList?.register(msg.name, msg.schema);
  }
  handleToolUnregistered(msg) {
    this._toolsList?.unregister(msg.name);
  }
  _onTabChange(event) {
    const tab = event.detail?.tab;
    if (!tab)
      return;
    this._activeTab = tab;
    if (tab === "traces")
      this._tracesList?.requestUpdate();
    if (tab === "memory")
      this._fetchKgraph();
    if (tab === "costs")
      this._costsTable?.requestUpdate();
  }
  _onActorSelect(event) {
    this._actorDetail?.show(event.detail.actor);
  }
  async _fetchKgraph() {
    this._memoryStatsText = "loading...";
    try {
      const res = await fetch(new URL("kgraph", location.href));
      const graph = await res.json();
      this._memoryGraph?.renderKnowledgeGraph(graph);
      this._memoryStatsText = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
    } catch {
      this._memoryStatsText = "error";
    }
  }
  _clearLogs() {
    const count = this._logStream?.clear() ?? 0;
    this._logCountText = `${count} events`;
  }
  _clearTraces() {
    this._tracesList?.clear();
    this._tracesCountText = "0 traces";
  }
  render() {
    const activeControl = CONTROL_BY_TAB[this._activeTab];
    const showMetrics = activeControl === "metrics-summary" && this._metrics.actors > 0;
    return html`
      <div class="obs-bar">
        <r-tabs class="obs-subtabs" @tab-change=${this._onTabChange}>
          <button class="obs-subtab ${this._activeTab === "metrics" ? "active" : ""}" data-subtab="metrics">metrics</button>
          <button class="obs-subtab ${this._activeTab === "topics" ? "active" : ""}" data-subtab="topics">topics</button>
          <button class="obs-subtab ${this._activeTab === "logs" ? "active" : ""}" data-subtab="logs">logs</button>
          <button class="obs-subtab ${this._activeTab === "traces" ? "active" : ""}" data-subtab="traces">traces</button>
          <button class="obs-subtab ${this._activeTab === "tools" ? "active" : ""}" data-subtab="tools">tools</button>
          <button class="obs-subtab ${this._activeTab === "memory" ? "active" : ""}" data-subtab="memory">memory</button>
          <button class="obs-subtab ${this._activeTab === "costs" ? "active" : ""}" data-subtab="costs">costs</button>
        </r-tabs>
        <div class="obs-bar-end">
          <div class="metrics-summary" ?hidden=${!showMetrics}>
            <div class="summary-stat">
              <span class="summary-val">${this._metrics.actors}</span>
              <span class="summary-key">actors</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val">${this._metrics.recv}</span>
              <span class="summary-key">recv</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val">${this._metrics.done}</span>
              <span class="summary-key">done</span>
            </div>
            <div class="summary-stat">
              <span class="summary-val">${this._metrics.fail}</span>
              <span class="summary-key">fail</span>
            </div>
          </div>
          <div class="obs-log-controls" ?hidden=${activeControl !== "obs-log-controls"}>
            <span class="log-count">${this._logCountText}</span>
            <button class="btn-clear" @click=${this._clearLogs}>clear</button>
          </div>
          <div class="obs-traces-controls" ?hidden=${activeControl !== "obs-traces-controls"}>
            <span class="log-count">${this._tracesCountText}</span>
            <button class="btn-clear" @click=${this._clearTraces}>clear</button>
          </div>
          <div class="obs-memory-controls" ?hidden=${activeControl !== "obs-memory-controls"}>
            <span class="log-count">${this._memoryStatsText}</span>
            <button class="btn-clear" @click=${this._fetchKgraph}>refresh</button>
          </div>
        </div>
      </div>

      <div class="obs-subpanel ${this._activeTab === "metrics" ? "active" : ""}">
        <div class="metrics-layout">
          <div class="tree-col">
            <r-actor-tree @actor-select=${this._onActorSelect}></r-actor-tree>
          </div>
          <div class="detail-col">
            <r-actor-detail></r-actor-detail>
          </div>
        </div>
      </div>

      <div class="obs-subpanel ${this._activeTab === "topics" ? "active" : ""}">
        <r-topic-list .topics=${store.get("topics")}></r-topic-list>
      </div>

      <div class="obs-subpanel ${this._activeTab === "traces" ? "active" : ""}">
        <r-trace-waterfall></r-trace-waterfall>
      </div>

      <div class="obs-subpanel ${this._activeTab === "logs" ? "active" : ""}">
        <r-log-stream></r-log-stream>
      </div>

      <div class="obs-subpanel ${this._activeTab === "tools" ? "active" : ""}">
        <r-tools-list></r-tools-list>
      </div>

      <r-costs-table class="obs-subpanel ${this._activeTab === "costs" ? "active" : ""}">
      </r-costs-table>

      <div class="obs-subpanel ${this._activeTab === "memory" ? "active" : ""}">
        <r-force-graph></r-force-graph>
      </div>
    `;
  }
}
__legacyDecorateClassTS([
  state()
], RObservePanel.prototype, "_activeTab", undefined);
__legacyDecorateClassTS([
  state()
], RObservePanel.prototype, "_metrics", undefined);
__legacyDecorateClassTS([
  state()
], RObservePanel.prototype, "_logCountText", undefined);
__legacyDecorateClassTS([
  state()
], RObservePanel.prototype, "_tracesCountText", undefined);
__legacyDecorateClassTS([
  state()
], RObservePanel.prototype, "_memoryStatsText", undefined);
__legacyDecorateClassTS([
  query("r-actor-tree")
], RObservePanel.prototype, "_actorTree", undefined);
__legacyDecorateClassTS([
  query("r-actor-detail")
], RObservePanel.prototype, "_actorDetail", undefined);
__legacyDecorateClassTS([
  query("r-topic-list")
], RObservePanel.prototype, "_topicList", undefined);
__legacyDecorateClassTS([
  query("r-log-stream")
], RObservePanel.prototype, "_logStream", undefined);
__legacyDecorateClassTS([
  query("r-trace-waterfall")
], RObservePanel.prototype, "_tracesList", undefined);
__legacyDecorateClassTS([
  query("r-tools-list")
], RObservePanel.prototype, "_toolsList", undefined);
__legacyDecorateClassTS([
  query("r-costs-table")
], RObservePanel.prototype, "_costsTable", undefined);
__legacyDecorateClassTS([
  query("r-force-graph")
], RObservePanel.prototype, "_memoryGraph", undefined);
RObservePanel = __legacyDecorateClassTS([
  customElement("r-observe-panel")
], RObservePanel);
// src/frontend/components/r-thinking-indicator.ts
class RThinkingIndicator extends RorschachBase {
  constructor() {
    super(...arguments);
    this.label = "";
  }
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.4rem;
      padding: 0.4rem 0;
    }

    .tool-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.62rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--accent);
      font-style: italic;
      opacity: 0.85;
      margin-bottom: 0.4rem;
      padding: 0.18rem 0.55rem;
      background: rgba(0, 196, 212, 0.07);
      border: 1px solid rgba(0, 196, 212, 0.18);
      border-radius: 6px;
    }

    .tool-badge::before {
      content: '⚙';
      font-style: normal;
      font-size: 0.65rem;
      opacity: 0.7;
      animation: streamPulse 1.4s ease-in-out infinite;
    }

    .dots-row {
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .dot {
      width: 4px; height: 4px;
      border-radius: 50%;
      background: var(--text-dim);
      animation: voidPulse 1.8s ease-in-out infinite;
    }

    .dot:nth-child(2) { animation-delay: 0.3s; background: var(--accent); }
    .dot:nth-child(3) { animation-delay: 0.6s; }

    @keyframes voidPulse {
      0%, 100% { opacity: 0.1; transform: scale(0.7); }
      50%       { opacity: 0.9; transform: scale(1.3); }
    }

    @keyframes streamPulse {
      0%, 100% { opacity: 0.3; }
      50%       { opacity: 1.0; }
    }
  `;
  render() {
    return html`
      ${this.label ? html`<div class="tool-badge">${this.label}</div>` : ""}
      <div class="dots-row">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    `;
  }
  show(toolLabel = "", extraClass = "") {
    this.label = toolLabel;
    if (extraClass)
      this.className = extraClass;
  }
}
__legacyDecorateClassTS([
  property({ type: String })
], RThinkingIndicator.prototype, "label", undefined);
RThinkingIndicator = __legacyDecorateClassTS([
  customElement("r-thinking-indicator")
], RThinkingIndicator);
// src/frontend/components/r-flash-message.ts
class RFlashMessage extends RorschachBase {
  constructor() {
    super(...arguments);
    this.visible = false;
    this.type = "";
    this.message = "";
  }
  _timer = null;
  static styles = css`
    :host {
      display: contents;
    }

    .msg {
      font-size: 0.68rem;
      font-family: var(--font-mono, monospace);
      font-weight: 300;
      opacity: 0;
      transition: opacity 0.3s;
      margin-left: auto;
      white-space: nowrap;
    }

    .msg.visible { opacity: 1; }
    .msg.save    { color: var(--green, #39e8a0); }
    .msg.error   { color: var(--error, #e06030); }
  `;
  render() {
    return html`
      <span class="msg ${this.type} ${this.visible ? "visible" : ""}">
        ${this.message}
      </span>
    `;
  }
  show(type, message, duration = 2200) {
    clearTimeout(this._timer);
    this.type = type;
    this.message = message;
    this.visible = true;
    this._timer = setTimeout(() => {
      this.visible = false;
    }, duration);
  }
  save(duration = 2200) {
    this.show("save", "saved", duration);
  }
  error(message, duration = 4000) {
    this.show("error", message, duration);
  }
}
__legacyDecorateClassTS([
  state()
], RFlashMessage.prototype, "visible", undefined);
__legacyDecorateClassTS([
  state()
], RFlashMessage.prototype, "type", undefined);
__legacyDecorateClassTS([
  state()
], RFlashMessage.prototype, "message", undefined);
RFlashMessage = __legacyDecorateClassTS([
  customElement("r-flash-message")
], RFlashMessage);
// src/frontend/components/r-attachments.ts
class RAttachments extends RorschachBase {
  constructor() {
    super(...arguments);
    this.items = [];
  }
  static styles = css`
    :host {
      display: block;
      margin-bottom: 0.35rem;
      white-space: normal;
    }

    .attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }

    .attachment {
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-secondary, rgba(255,255,255,0.03));
    }

    .attachment-image {
      max-width: 200px;
      max-height: 150px;
      display: block;
      border-radius: 4px;
    }

    .attachment-audio {
      display: block;
      max-width: 250px;
    }

    .attachment-video {
      max-width: 250px;
      max-height: 180px;
      display: block;
      border-radius: 4px;
    }

    .attachment-file {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.4rem 0.6rem;
      color: var(--accent, #7aa2f7);
      text-decoration: none;
      font-size: 0.78rem;
    }

    .attachment-file:hover {
      text-decoration: underline;
    }

    .attachment-caption {
      font-size: 0.7rem;
      color: var(--muted, #8a8a8a);
      padding: 0.2rem 0.4rem;
    }
  `;
  render() {
    if (!this.items || this.items.length === 0)
      return html``;
    return html`
      <div class="attachments">
        ${this.items.map((a) => this.renderAttachment(a))}
      </div>
    `;
  }
  renderAttachment(a) {
    if (a.kind === "image") {
      return html`
        <div class="attachment attachment-image">
          <img src="${a.url}" class="attachment-image" ?alt="${a.alt}" .alt="${a.alt || ""}">
        </div>
      `;
    } else if (a.kind === "audio") {
      return html`
        <div class="attachment attachment-audio">
          <audio src="${a.url}" controls class="attachment-audio"></audio>
          ${a.alt ? html`<div class="attachment-caption">${a.alt}</div>` : ""}
        </div>
      `;
    } else if (a.kind === "video") {
      return html`
        <div class="attachment attachment-video">
          <video src="${a.url}" controls class="attachment-video"></video>
          ${a.alt ? html`<div class="attachment-caption">${a.alt}</div>` : ""}
        </div>
      `;
    } else {
      return html`
        <div class="attachment attachment-file">
          <a href="${a.url}" target="_blank" rel="noopener noreferrer" class="attachment-file">
            ${a.alt || a.url.split("/").pop() || "file"}
          </a>
        </div>
      `;
    }
  }
  renderLegacy(attachments) {
    this.items = attachments;
  }
}
__legacyDecorateClassTS([
  property({ type: Array })
], RAttachments.prototype, "items", undefined);
RAttachments = __legacyDecorateClassTS([
  customElement("r-attachments")
], RAttachments);
// src/frontend/components/r-sources-list.ts
class RSourcesList extends RorschachBase {
  constructor() {
    super(...arguments);
    this.sources = [];
    this.open = false;
  }
  static styles = css`
    :host {
      display: block;
      margin-bottom: 0.35rem;
      white-space: normal;
    }

    .sources {
      display: flex;
      flex-direction: column;
    }

    .sources-toggle {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0;
      display: flex;
      align-items: center;
      gap: 0.3rem;
      opacity: 0.7;
      transition: opacity 0.15s;
    }

    .sources-toggle:hover {
      opacity: 1;
    }

    .sources-toggle .icon {
      display: inline-flex;
      transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .sources-toggle.open .icon {
      transform: rotate(90deg);
    }

    .sources-list {
      display: none;
      flex-direction: column;
      gap: 0.2rem;
      margin-top: 0.35rem;
      padding-left: 0.5rem;
      border-left: 1px solid rgba(0, 196, 212, 0.1);
    }

    .sources-list.open {
      display: flex;
    }

    .source-item {
      display: flex;
      flex-direction: column;
      padding: 0.25rem 0.45rem;
      border-radius: 4px;
      text-decoration: none;
      color: inherit;
      background: rgba(255, 255, 255, 0.03);
      transition: background 0.15s, transform 0.1s;
    }

    .source-item:hover {
      background: rgba(255, 255, 255, 0.06);
      transform: translateX(2px);
    }

    .source-title {
      font-size: 0.75rem;
      color: var(--bot-text);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .source-snippet {
      font-size: 0.65rem;
      color: var(--text-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 0.05rem;
    }
  `;
  render() {
    if (!this.sources || this.sources.length === 0)
      return html``;
    const count = this.sources.length;
    const label = `${count} source${count !== 1 ? "s" : ""}`;
    return html`
      <div class="sources">
        <button class="sources-toggle ${this.open ? "open" : ""}" @click=${this.toggle}>
          <span class="icon">${this.renderIcon("chevron-right")}</span>
          ${label}
        </button>
        <div class="sources-list ${this.open ? "open" : ""}">
          ${this.sources.map((s) => html`
            <a class="source-item" href="${s.url}" target="_blank" rel="noopener noreferrer">
              <span class="source-title">${s.title || s.url}</span>
              ${s.snippet ? html`<span class="source-snippet">${s.snippet}</span>` : ""}
            </a>
          `)}
        </div>
      </div>
    `;
  }
  toggle() {
    this.open = !this.open;
  }
  renderLegacy(sources) {
    this.sources = sources;
  }
}
__legacyDecorateClassTS([
  property({ type: Array })
], RSourcesList.prototype, "sources", undefined);
__legacyDecorateClassTS([
  state()
], RSourcesList.prototype, "open", undefined);
RSourcesList = __legacyDecorateClassTS([
  customElement("r-sources-list")
], RSourcesList);
// src/frontend/components/r-media-previews.ts
class RMediaPreviews extends RorschachBase {
  constructor() {
    super(...arguments);
    this.images = [];
    this.audio = null;
    this.pdfs = [];
  }
  static styles = css`
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 0.65rem;
    }

    :host(.hidden) {
      display: none;
    }

    .image-thumb-wrap {
      position: relative;
      display: inline-flex;
    }

    .image-thumb {
      width: 60px;
      height: 60px;
      object-fit: cover;
      border-radius: calc(var(--radius, 8px) - 2px);
      border: 1px solid var(--border-mid);
    }

    .image-thumb-remove {
      position: absolute;
      top: -6px; right: -6px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--surface-2);
      border: 1px solid var(--border-mid);
      color: var(--muted);
      font-size: 0.7rem;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .image-thumb-remove:hover { color: var(--text); }

    .audio-preview-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      height: 60px;
    }

    .audio-preview-player {
      height: 32px;
      width: 220px;
      accent-color: var(--accent);
      border-radius: calc(var(--radius, 8px) - 2px);
      outline: none;
    }

    .pdf-preview-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      height: 36px;
      padding: 0 0.6rem;
      background: var(--surface-2);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius, 8px);
      color: var(--muted);
      font-size: 0.72rem;
      max-width: 200px;
    }

    .pdf-preview-icon {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      color: var(--accent);
    }

    .pdf-preview-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pdf-remove {
      margin-left: 0.25rem;
      flex-shrink: 0;
    }
  `;
  render() {
    const hasContent = this.images.length > 0 || this.audio !== null || this.pdfs.length > 0;
    this.classList.toggle("hidden", !hasContent);
    if (!hasContent)
      return html``;
    return html`
      ${this.images.map((dataUrl, i) => html`
        <div class="image-thumb-wrap">
          <img src="${dataUrl}" class="image-thumb">
          <button class="image-thumb-remove" @click=${() => this.removeMedia("image", i)}>&times;</button>
        </div>
      `)}

      ${this.audio ? html`
        <div class="audio-preview-wrap">
          <audio src="${this.audio}" controls class="audio-preview-player"></audio>
          <button class="image-thumb-remove" @click=${() => this.removeMedia("audio")}>&times;</button>
        </div>
      ` : ""}

      ${this.pdfs.map((pdf, i) => html`
        <div class="pdf-preview-wrap">
          <span class="pdf-preview-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </span>
          <span class="pdf-preview-name">${pdf.name}</span>
          <button class="image-thumb-remove pdf-remove" @click=${() => this.removeMedia("pdf", i)}>&times;</button>
        </div>
      `)}
    `;
  }
  getPending() {
    return {
      images: [...this.images],
      audio: this.audio,
      pdfs: [...this.pdfs]
    };
  }
  clear() {
    this.images = [];
    this.audio = null;
    this.pdfs = [];
  }
  addImage(dataUrl) {
    this.images = [...this.images, dataUrl];
  }
  setAudio(dataUrl) {
    this.audio = dataUrl;
  }
  addPdf(dataUrl, name) {
    this.pdfs = [...this.pdfs, { dataUrl, name }];
  }
  removeMedia(type, index) {
    if (type === "image" && index !== undefined) {
      this.images = this.images.filter((_, i) => i !== index);
    } else if (type === "audio") {
      this.audio = null;
    } else if (type === "pdf" && index !== undefined) {
      this.pdfs = this.pdfs.filter((_, i) => i !== index);
    }
    this.dispatchEvent(new CustomEvent("media-remove", { bubbles: true, composed: true }));
  }
}
__legacyDecorateClassTS([
  state()
], RMediaPreviews.prototype, "images", undefined);
__legacyDecorateClassTS([
  state()
], RMediaPreviews.prototype, "audio", undefined);
__legacyDecorateClassTS([
  state()
], RMediaPreviews.prototype, "pdfs", undefined);
RMediaPreviews = __legacyDecorateClassTS([
  customElement("r-media-previews")
], RMediaPreviews);
// src/frontend/components/r-message-bubble.ts
class RMessageBubble extends RorschachBase {
  constructor() {
    super(...arguments);
    this.type = "assistant";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.classList.add("message", this.type);
    this._ensureStructure();
  }
  updated(changedProperties) {
    if (changedProperties.has("type")) {
      this.classList.remove("assistant", "user", "error");
      this.classList.add(this.type);
      const labelEl = this.querySelector(".message-label");
      if (labelEl) {
        labelEl.textContent = this._getLabelText();
      }
    }
  }
  _getLabelText() {
    return this.type === "user" ? "You" : this.type === "error" ? "Error" : "Rorschach";
  }
  _ensureStructure() {
    if (!this.querySelector(".bubble")) {
      const labelText = this._getLabelText();
      this.innerHTML = `<div class="message-label">${labelText}</div><div class="bubble"></div>`;
    }
  }
  get bubbleContainer() {
    this._ensureStructure();
    return this.querySelector(".bubble");
  }
  render() {
    return html``;
  }
  addBody() {
    const body = document.createElement("div");
    body.className = "bubble-body";
    this.bubbleContainer?.appendChild(body);
    return body;
  }
  addImages(images) {
    const bubble = this.bubbleContainer;
    if (!bubble)
      return;
    const imgRow = document.createElement("div");
    imgRow.className = "message-images";
    images.forEach((a) => {
      const img = document.createElement("img");
      img.src = a.data;
      img.className = "message-image";
      imgRow.appendChild(img);
    });
    bubble.appendChild(imgRow);
  }
  addAudio(audioData) {
    const bubble = this.bubbleContainer;
    if (!bubble)
      return;
    const audioEl = document.createElement("audio");
    audioEl.src = audioData;
    audioEl.controls = true;
    audioEl.className = "message-audio";
    bubble.appendChild(audioEl);
  }
  addPdfs(pdfs) {
    const bubble = this.bubbleContainer;
    if (!bubble)
      return;
    pdfs.forEach((pdf) => {
      const chip = document.createElement("div");
      chip.className = "message-pdf-chip";
      chip.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      const nameSpan = document.createElement("span");
      nameSpan.textContent = pdf.name;
      chip.appendChild(nameSpan);
      bubble.appendChild(chip);
    });
  }
  addText(text) {
    const bubble = this.bubbleContainer;
    if (!bubble)
      return;
    const textEl = document.createElement("span");
    textEl.textContent = text;
    bubble.appendChild(textEl);
  }
  addSources(sourcesEl) {
    const bubble = this.bubbleContainer;
    if (!bubble)
      return;
    const body = bubble.querySelector(".bubble-body");
    if (body) {
      bubble.insertBefore(sourcesEl, body);
    } else {
      bubble.appendChild(sourcesEl);
    }
  }
  addAttachments(attachmentsEl) {
    const bubble = this.bubbleContainer;
    if (!bubble)
      return;
    const body = bubble.querySelector(".bubble-body");
    if (body) {
      bubble.insertBefore(attachmentsEl, body);
    } else {
      bubble.appendChild(attachmentsEl);
    }
  }
  addReasoningSection() {
    const bubble = this.bubbleContainer;
    if (!bubble)
      return null;
    const details = document.createElement("details");
    details.className = "reasoning";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking...";
    const content = document.createElement("pre");
    content.className = "reasoning-content";
    details.appendChild(summary);
    details.appendChild(content);
    bubble.appendChild(details);
    return content;
  }
}
__legacyDecorateClassTS([
  property({ type: String, reflect: true })
], RMessageBubble.prototype, "type", undefined);
RMessageBubble = __legacyDecorateClassTS([
  customElement("r-message-bubble")
], RMessageBubble);
// src/frontend/components/r-chat-input.ts
class RChatInput extends RorschachBase {
  constructor() {
    super(...arguments);
    this._isConnected = false;
    this.isWaiting = false;
    this.pendingImages = [];
    this.pendingAudio = null;
    this.pendingPdfs = [];
    this.isRecording = false;
  }
  _unsub = [];
  _mediaRecorder = null;
  _audioCtx = null;
  _recordingStream = null;
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this._unsub.push(store.subscribe("isConnected", (v) => this._isConnected = v));
    this._unsub.push(store.subscribe("isWaiting", (v) => this.isWaiting = v));
    this._isConnected = store.get("isConnected");
    this.isWaiting = store.get("isWaiting");
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsub.forEach((un) => un());
    this._unsub = [];
  }
  getPending() {
    return {
      images: [...this.pendingImages],
      audio: this.pendingAudio,
      pdfs: [...this.pendingPdfs]
    };
  }
  clearPending() {
    this.pendingImages = [];
    this.pendingAudio = null;
    this.pendingPdfs = [];
    const previews = this.querySelector("r-media-previews");
    previews?.clear();
  }
  focus() {
    this.inputEl?.focus();
  }
  _handleInput() {
    const input = this.inputEl;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
  }
  _handleKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this._submit();
    }
  }
  _submit() {
    const text = this.inputEl.value.trim();
    const attachments = [
      ...this.pendingImages.map((data) => ({ kind: "image", data })),
      ...this.pendingAudio ? [{ kind: "audio", data: this.pendingAudio }] : [],
      ...this.pendingPdfs.map((p) => ({ kind: "pdf", data: p.dataUrl, name: p.name }))
    ];
    if (!text && attachments.length === 0)
      return;
    this.dispatchEvent(new CustomEvent("chat-submit", {
      bubbles: true,
      composed: true,
      detail: { text, attachments }
    }));
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.clearPending();
  }
  async _handleFileChange() {
    const files = Array.from(this.fileInputEl.files ?? []);
    for (const file of files) {
      const dataUrl = await this._readFileAsDataUrl(file);
      const previews = this.querySelector("r-media-previews");
      if (file.type.startsWith("image/")) {
        this.pendingImages = [...this.pendingImages, dataUrl];
        previews?.addImage(dataUrl);
      } else if (file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name)) {
        this.pendingAudio = dataUrl;
        previews?.setAudio(dataUrl);
      } else if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        this.pendingPdfs = [...this.pendingPdfs, { dataUrl, name: file.name }];
        previews?.addPdf(dataUrl, file.name);
      }
    }
    this.fileInputEl.value = "";
  }
  async _toggleRecording() {
    if (this.isRecording) {
      this._mediaRecorder?.stop();
      return;
    }
    try {
      this._recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return;
    }
    const processorSrc = `
      class RecorderProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0]?.[0]
          if (ch) this.port.postMessage(new Float32Array(ch))
          return true
        }
      }
      registerProcessor('recorder-processor', RecorderProcessor)
    `;
    const workletBlob = new Blob([processorSrc], { type: "application/javascript" });
    const workletUrl = URL.createObjectURL(workletBlob);
    this._audioCtx = new AudioContext({ sampleRate: 16000 });
    await this._audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    const source = this._audioCtx.createMediaStreamSource(this._recordingStream);
    const workletNode = new AudioWorkletNode(this._audioCtx, "recorder-processor");
    const samples = [];
    workletNode.port.onmessage = (e) => {
      samples.push(e.data);
    };
    source.connect(workletNode);
    this.isRecording = true;
    this._mediaRecorder = {
      stop: () => {
        this.isRecording = false;
        workletNode.disconnect();
        source.disconnect();
        this._audioCtx?.close();
        this._recordingStream?.getTracks().forEach((t) => t.stop());
        const totalLen = samples.reduce((n, s) => n + s.length, 0);
        const pcm = new Int16Array(totalLen);
        let offset = 0;
        for (const chunk of samples) {
          for (let i = 0;i < chunk.length; i++) {
            const val = chunk[i] ?? 0;
            pcm[offset++] = Math.max(-32768, Math.min(32767, val * 32768));
          }
        }
        const wav = this._pcm16ToWav(pcm, 16000);
        const blob = new Blob([wav], { type: "audio/wav" });
        const reader = new FileReader;
        reader.onload = () => {
          this.pendingAudio = reader.result;
          const previews = this.querySelector("r-media-previews");
          previews?.setAudio(reader.result);
        };
        reader.readAsDataURL(blob);
      }
    };
  }
  _readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader;
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  _pcm16ToWav(pcm, sampleRate) {
    const dataBytes = pcm.buffer;
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const channels = 1;
    const byteRate = sampleRate * channels * 2;
    const dataSize = dataBytes.byteLength;
    const writeStr = (offset, str) => {
      for (let i = 0;i < str.length; i++)
        view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);
    const out = new Uint8Array(44 + dataSize);
    out.set(new Uint8Array(header), 0);
    out.set(new Uint8Array(dataBytes), 44);
    return out;
  }
  render() {
    const disabled = !this.isConnected || this.isWaiting;
    return html`
      <div class="input-area">
        <r-media-previews id="image-previews" class="image-previews hidden"></r-media-previews>
        <form id="chat-form" @submit=${(e) => {
      e.preventDefault();
      this._submit();
    }}>
          <input type="file" id="file-input" accept="image/*,audio/*,.mp3,.wav,application/pdf,.pdf" multiple style="display:none" @change=${this._handleFileChange}>
          <button type="button" id="attach-btn" aria-label="Attach file" @click=${() => this.fileInputEl.click()}>
            ${this.renderIcon("attach")}
          </button>
          <button type="button" id="mic-btn" class="${this.isRecording ? "recording" : ""}" aria-label="Record audio" @click=${this._toggleRecording}>
            ${this.renderIcon("mic")}
          </button>
          <textarea
            id="input"
            placeholder="Message…"
            autocomplete="off"
            rows="1"
            ?disabled=${disabled}
            @input=${this._handleInput}
            @keydown=${this._handleKeydown}
          ></textarea>
          <button type="submit" id="send" ?disabled=${disabled} aria-label="Send">
            ${this.renderIcon("send")}
          </button>
        </form>
        <p class="input-hint">Enter to send &nbsp;·&nbsp; Shift+Enter for new line</p>
      </div>
    `;
  }
}
__legacyDecorateClassTS([
  state()
], RChatInput.prototype, "_isConnected", undefined);
__legacyDecorateClassTS([
  state()
], RChatInput.prototype, "isWaiting", undefined);
__legacyDecorateClassTS([
  state()
], RChatInput.prototype, "pendingImages", undefined);
__legacyDecorateClassTS([
  state()
], RChatInput.prototype, "pendingAudio", undefined);
__legacyDecorateClassTS([
  state()
], RChatInput.prototype, "pendingPdfs", undefined);
__legacyDecorateClassTS([
  state()
], RChatInput.prototype, "isRecording", undefined);
__legacyDecorateClassTS([
  query("#input")
], RChatInput.prototype, "inputEl", undefined);
__legacyDecorateClassTS([
  query("#file-input")
], RChatInput.prototype, "fileInputEl", undefined);
RChatInput = __legacyDecorateClassTS([
  customElement("r-chat-input")
], RChatInput);
// src/frontend/markdown.ts
marked.use({
  extensions: [
    {
      name: "blockMath",
      level: "block",
      start(src) {
        return src.indexOf("$$");
      },
      tokenizer(src) {
        const match = src.match(/^\$\$([\s\S]+?)\$\$/);
        if (match)
          return { type: "blockMath", raw: match[0], math: match[1]?.trim() };
      },
      renderer(token) {
        return '<div class="math-block">' + katex.renderToString(token.math, { displayMode: true, throwOnError: false }) + "</div>";
      }
    },
    {
      name: "inlineMath",
      level: "inline",
      start(src) {
        return src.indexOf("$");
      },
      tokenizer(src) {
        const match = src.match(/^\$([^$\n]+?)\$/);
        if (match)
          return { type: "inlineMath", raw: match[0], math: match[1]?.trim() };
      },
      renderer(token) {
        return '<span class="math-inline">' + katex.renderToString(token.math, { displayMode: false, throwOnError: false }) + "</span>";
      }
    }
  ]
});
marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    link(href, title, text) {
      const ytMatch = href.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?|shorts)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
      if (ytMatch) {
        const videoId = ytMatch[1];
        const embed = `<div class="video-container"><iframe src="https://www.youtube-nocookie.com/embed/${videoId}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>`;
        const isBareLink = text === href || text === href.replace(/^https?:\/\//, "") || text === href.replace(/^https?:\/\/www\./, "");
        if (isBareLink) {
          return embed;
        } else {
          return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>${embed}`;
        }
      }
      return false;
    }
  }
});
function copyCode(btn) {
  const codeBlock = btn.closest(".code-block");
  if (!codeBlock)
    return;
  const codeEl = codeBlock.querySelector("code");
  if (!codeEl)
    return;
  const code = codeEl.textContent || "";
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "copied";
    setTimeout(() => {
      btn.textContent = "copy";
    }, 1800);
  });
}
window.copyCode = copyCode;
function renderMarkdown(text) {
  const el = document.createElement("div");
  el.className = "md";
  el.innerHTML = marked.parse(text);
  el.querySelectorAll("pre > code").forEach((block) => {
    const langClass = Array.from(block.classList).find((c) => c.startsWith("language-"));
    const lang = langClass ? langClass.replace("language-", "") : "code";
    hljs.highlightElement(block);
    const pre = block.parentElement;
    if (!pre)
      return;
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const header = document.createElement("div");
    header.className = "code-header";
    header.innerHTML = `<span class="code-lang">${lang}</span><button class="copy-btn" onclick="copyCode(this)">copy</button>`;
    pre.replaceWith(wrapper);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
  return el;
}

// src/frontend/components/r-chat-panel.ts
function toolActionLabel(toolName) {
  if (toolName === "web_search")
    return "searching the web...";
  if (toolName === "analyze_image")
    return "analysing image...";
  return `running ${toolName}...`;
}

class RChatPanel extends RorschachBase {
  _thinkingEl = null;
  _streamWrap = null;
  _streamBubbleContainer = null;
  _streamBubble = null;
  _streamRawText = "";
  _reasoningEl = null;
  _pendingSources = null;
  _pendingAttachments = null;
  _unsubConnected = null;
  _onFrame = (event) => this.handleFrame(event.detail);
  _onSubmit = (event) => this._handleSubmit(event);
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("chat-submit", this._onSubmit);
    document.addEventListener("ws-message", this._onFrame);
    this._unsubConnected = store.subscribe("isConnected", (connected) => {
      if (!connected) {
        this.removeThinking();
        this.resetStream();
      }
    });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("chat-submit", this._onSubmit);
    document.removeEventListener("ws-message", this._onFrame);
    this._unsubConnected?.();
    this._unsubConnected = null;
  }
  get messagesEl() {
    return this.querySelector("#messages");
  }
  get emptyEl() {
    return this.querySelector("#empty");
  }
  get chatInput() {
    return this.querySelector("r-chat-input");
  }
  focus() {
    this.chatInput?.focus();
  }
  resetStream() {
    this._streamWrap = null;
    this._streamBubbleContainer = null;
    this._streamBubble = null;
    this._streamRawText = "";
    this._reasoningEl = null;
    this._pendingSources = null;
    this._pendingAttachments = null;
  }
  removeThinking() {
    this._thinkingEl?.remove();
    this._thinkingEl = null;
  }
  handleFrame(msg) {
    if (msg.type === "tooling") {
      this.removeThinking();
      const tools = msg.tools ?? [];
      const label = tools.length === 1 ? toolActionLabel(tools[0]) : tools.length > 1 ? `invoking ${tools.length} tools...` : "working...";
      this._showThinking(label, "searching");
    } else if (msg.type === "sources") {
      this._pendingSources = msg.sources;
    } else if (msg.type === "attachments") {
      this._handleAttachments(msg.attachments);
    } else if (msg.type === "reasoningChunk") {
      this._appendReasoning(msg.text);
    } else if (msg.type === "chunk") {
      this._appendChunk(msg.text);
    } else if (msg.type === "done") {
      this._finishStream();
    } else if (msg.type === "error") {
      this._showError(msg.text);
    }
  }
  render() {
    return html`
      <div class="chat-main">
        <div id="messages">
          <r-empty-state id="empty" variant="chat" name="signal" text="Signal detected" subtext="awaiting transmission"></r-empty-state>
        </div>
        <div class="chat-dock">
          <r-chat-input></r-chat-input>
        </div>
      </div>
    `;
  }
  _scrollToBottom() {
    const messagesEl = this.messagesEl;
    if (messagesEl)
      messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  _ensureStreamWrap() {
    if (!this._streamWrap) {
      const bubble = document.createElement("r-message-bubble");
      bubble.type = "assistant";
      this._streamWrap = bubble;
      this._streamBubbleContainer = bubble.bubbleContainer;
      this.messagesEl?.appendChild(this._streamWrap);
    }
  }
  _showThinking(toolLabel = "", extraClass = "") {
    this.emptyEl?.remove();
    this._ensureStreamWrap();
    const indicator = document.createElement("r-thinking-indicator");
    indicator.show(toolLabel, extraClass);
    this._streamBubbleContainer?.appendChild(indicator);
    this._scrollToBottom();
    this._thinkingEl = indicator;
  }
  _appendUserMessage(text, attachments = []) {
    this.emptyEl?.remove();
    const bubble = document.createElement("r-message-bubble");
    bubble.type = "user";
    const images = attachments.filter((a) => a.kind === "image");
    if (images.length > 0)
      bubble.addImages(images);
    const audio = attachments.find((a) => a.kind === "audio");
    if (audio)
      bubble.addAudio(audio.data);
    const pdfs = attachments.filter((a) => a.kind === "pdf");
    if (pdfs.length > 0)
      bubble.addPdfs(pdfs);
    if (text)
      bubble.addText(text);
    this.messagesEl?.appendChild(bubble);
    this._scrollToBottom();
  }
  _handleAttachments(attachments) {
    if (this._streamBubbleContainer) {
      const wrap2 = document.createElement("r-attachments");
      wrap2.renderLegacy(attachments);
      if (this._streamBubble)
        this._streamBubbleContainer.insertBefore(wrap2, this._streamBubble);
      else
        this._streamBubbleContainer.appendChild(wrap2);
    } else {
      this._pendingAttachments = attachments;
    }
  }
  _appendReasoning(text) {
    this.removeThinking();
    this._ensureStreamWrap();
    if (!this._reasoningEl) {
      this._reasoningEl = this._streamWrap.addReasoningSection();
    }
    if (this._reasoningEl)
      this._reasoningEl.textContent += text;
    this._scrollToBottom();
  }
  _appendChunk(text) {
    if (!this._streamBubble) {
      this.removeThinking();
      this.messagesEl?.classList.add("receiving");
      setTimeout(() => this.messagesEl?.classList.remove("receiving"), 700);
      this._ensureStreamWrap();
      this._reasoningEl = null;
      const bodyEl = document.createElement("div");
      bodyEl.className = "bubble-body";
      if (this._pendingSources) {
        const sourcesList = document.createElement("r-sources-list");
        sourcesList.renderLegacy(this._pendingSources);
        this._streamBubbleContainer?.appendChild(sourcesList);
        this._pendingSources = null;
      }
      if (this._pendingAttachments) {
        const attachmentsEl = document.createElement("r-attachments");
        attachmentsEl.renderLegacy(this._pendingAttachments);
        this._streamBubbleContainer?.appendChild(attachmentsEl);
        this._pendingAttachments = null;
      }
      this._streamBubbleContainer?.appendChild(bodyEl);
      this._streamBubble = bodyEl;
      this._streamRawText = "";
    }
    this._streamRawText += text;
    if (this._streamBubble)
      this._streamBubble.textContent = this._streamRawText;
    this._scrollToBottom();
  }
  _finishStream() {
    if (this._streamBubble && this._streamRawText) {
      this._streamBubble.textContent = "";
      this._streamBubble.appendChild(renderMarkdown(this._streamRawText));
    }
    if (this._pendingAttachments) {
      this._ensureStreamWrap();
      const attachmentsEl = document.createElement("r-attachments");
      attachmentsEl.renderLegacy(this._pendingAttachments);
      this._streamBubbleContainer?.appendChild(attachmentsEl);
      this._pendingAttachments = null;
    }
    this.resetStream();
    store.set("isWaiting", false);
    if (document.querySelector('[data-tab="chat"].active'))
      this.focus();
  }
  _showError(text) {
    this.removeThinking();
    this.resetStream();
    const bubble = document.createElement("r-message-bubble");
    bubble.type = "error";
    const textEl = document.createElement("div");
    textEl.className = "bubble-body";
    textEl.textContent = text;
    bubble.bubbleContainer?.appendChild(textEl);
    this.messagesEl?.appendChild(bubble);
    this._scrollToBottom();
    store.set("isWaiting", false);
    if (document.querySelector('[data-tab="chat"].active'))
      this.focus();
  }
  _handleSubmit(event) {
    const { text, attachments } = event.detail;
    const ws = store.get("ws");
    if (!text && attachments.length === 0 || ws?.readyState !== WebSocket.OPEN || store.get("isWaiting"))
      return;
    this._appendUserMessage(text, attachments);
    ws.send(JSON.stringify({ text, attachments }));
    store.set("isWaiting", true);
    this._showThinking();
    const logoMark = document.querySelector(".logo-mark");
    logoMark?.classList.add("noticing");
    setTimeout(() => logoMark?.classList.remove("noticing"), 700);
  }
}
RChatPanel = __legacyDecorateClassTS([
  customElement("r-chat-panel")
], RChatPanel);
// src/frontend/components/r-config-form.ts
class RConfigForm extends RorschachBase {
  constructor() {
    super(...arguments);
    this.schemas = [];
    this.currentValues = {};
    this.models = [];
    this.activeTab = null;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("tab-change", (e) => {
      this.activeTab = e.detail?.tab;
    });
  }
  async loadSchemas() {
    await this._fetchConfigSchema();
    if (this.schemas.length === 0)
      return;
    if (!this.activeTab) {
      this.activeTab = this.schemas[0]?.tab || null;
    }
    await Promise.all([this._fetchCurrentValues(), this._fetchModels()]);
    this.requestUpdate();
  }
  async _fetchConfigSchema() {
    try {
      const res = await fetch(new URL("config/schema", location.href));
      if (res.ok)
        this.schemas = await res.json();
    } catch {}
  }
  async _fetchCurrentValues() {
    const pluginPaths = [...new Set(this.schemas.map((s) => {
      const pluginId = s.id.split(".")[0];
      return `/config/${pluginId}`;
    }))];
    for (const path of pluginPaths) {
      try {
        const res = await fetch(new URL(path.slice(1), location.href));
        if (res.ok) {
          const pluginId = path.split("/").pop();
          this.currentValues = { ...this.currentValues, [pluginId]: await res.json() };
        }
      } catch {}
    }
  }
  async _fetchModels() {
    try {
      const res = await fetch(new URL("models", location.href));
      if (res.ok)
        this.models = await res.json();
    } catch {}
  }
  async save() {
    const byPlugin = this._gatherValuesByPlugin();
    for (const [pluginId, patch] of Object.entries(byPlugin)) {
      try {
        const res = await fetch(new URL(`config/${pluginId}`, location.href), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch)
        });
        if (!res.ok)
          throw new Error(`server error ${res.status}`);
      } catch (err) {
        this._flashError(`Failed to save ${pluginId}: ${err.message}`);
        return;
      }
    }
    this._flashSaved();
  }
  reset() {
    this.loadSchemas();
  }
  render() {
    const byTab = {};
    for (const s of this.schemas) {
      (byTab[s.tab] ??= []).push(s);
    }
    const tabNames = Object.keys(byTab);
    return html`
      <div class="config-bar">
        <r-tabs class="config-subtabs" id="config-tabs">
          ${tabNames.map((tab, i) => html`
            <button class="config-subtab ${this.activeTab === tab ? "active" : ""}" 
                    data-config-tab="${tab}"
                    @click=${() => this.activeTab = tab}>
              ${tab}
            </button>
          `)}
        </r-tabs>
      </div>
      <div class="config-content">
        <form id="config-form" novalidate @submit=${(e) => {
      e.preventDefault();
      this.save();
    }}>
          <div id="config-form-container">
            ${tabNames.map((tab) => html`
              <div class="config-pane ${this.activeTab === tab ? "active" : ""}" data-config-pane="${tab}">
                ${byTab[tab]?.map((section) => this._renderSection(section))}
              </div>
            `)}
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-save">Save</button>
            <button type="button" class="btn-reset" id="reset-btn" @click=${this.reset}>Reset</button>
            <r-flash-message id="flash-msg"></r-flash-message>
          </div>
        </form>
      </div>
    `;
  }
  _renderSection(section) {
    const pluginId = section.id.split(".")[0] ?? 0;
    const pluginValues = this.currentValues[pluginId] ?? {};
    const configKey = section.configKey ?? "";
    let values = pluginValues;
    if (configKey) {
      for (const part of configKey.split(".")) {
        values = values?.[part] ?? {};
      }
    }
    const props = section.schema.properties ?? {};
    return html`
      <div class="config-section">
        <div class="pane-header">
          <span class="pane-title">${section.title}</span>
          ${section.subtitle ? html`<span class="pane-sub">${section.subtitle}</span>` : ""}
        </div>
        ${Object.entries(props).map(([key, fieldSchema]) => this._renderField(section.id, configKey, key, fieldSchema, values[key]))}
      </div>
    `;
  }
  _renderField(sectionId, configKey, key, schema, value) {
    const widget = schema["x-ui"]?.widget ?? this._inferWidget(schema);
    const secret = schema["x-ui"]?.secret ?? false;
    const label = schema["x-ui"]?.label ?? key;
    const resolvedValue = value ?? schema.default ?? "";
    let fieldContent;
    if (widget === "toggle") {
      fieldContent = html`
        <div class="field-row">
          <div>
            <div class="field-label">${label}</div>
            ${schema.description ? html`<div class="field-hint">${schema.description}</div>` : ""}
          </div>
          <label class="toggle">
            <input type="checkbox" name="${key}" .checked=${!!resolvedValue} 
                   data-section="${sectionId}" data-config-key="${configKey}">
            <span class="toggle-track"></span>
          </label>
        </div>`;
    } else if (widget === "select") {
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <select id="${sectionId}-${key}" name="${key}" data-section="${sectionId}" data-config-key="${configKey}">
          ${(schema.enum ?? []).map((v) => html`
            <option value="${v}" ?selected=${v === resolvedValue}>${v}</option>
          `)}
        </select>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ""}`;
    } else if (widget === "model-select") {
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <select id="${sectionId}-${key}" name="${key}" data-section="${sectionId}" data-config-key="${configKey}" data-widget="model-select">
          <option value="">— none —</option>
          ${this.models.map((m) => html`
            <option value="${m}" ?selected=${m === resolvedValue}>${m}</option>
          `)}
        </select>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ""}`;
    } else if (widget === "textarea") {
      const rows = schema["x-ui"]?.rows ?? 3;
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <textarea id="${sectionId}-${key}" name="${key}" rows="${rows}" 
                  data-section="${sectionId}" data-config-key="${configKey}">${resolvedValue}</textarea>
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ""}`;
    } else if (widget === "google-account") {
      fieldContent = this._renderGoogleAccountWidget();
    } else {
      const inputType = secret ? "password" : widget === "number" ? "number" : "text";
      fieldContent = html`
        <label class="field-label" for="${sectionId}-${key}">${label}</label>
        <input type="${inputType}" id="${sectionId}-${key}" name="${key}" .value="${resolvedValue}" 
               data-section="${sectionId}" data-config-key="${configKey}"
               ?min=${schema.minimum != null} .min=${schema.minimum}
               ?max=${schema.maximum != null} .max=${schema.maximum}
               placeholder="${schema.default ?? ""}">
        ${schema.description ? html`<span class="field-hint">${schema.description}</span>` : ""}`;
    }
    return html`
      <div class="field" data-section-id="${sectionId}" data-config-key="${configKey}" data-field-key="${key}">
        ${fieldContent}
      </div>
    `;
  }
  _renderGoogleAccountWidget() {
    return html`
      <div class="field-row" data-widget="google-account" @hook-google-status=${this._initGoogleAccountWidget}>
        <div>
          <div class="field-label">Google account</div>
          <div class="field-hint" data-google-status>checking…</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button type="button" class="btn-save" data-google-connect style="display:none">Connect</button>
          <button type="button" class="btn-reset" data-google-disconnect style="display:none">Disconnect</button>
        </div>
      </div>`;
  }
  _initGoogleAccountWidget(e) {
    const wrapper = e.target;
    const statusEl = wrapper.querySelector("[data-google-status]");
    const connectBtn = wrapper.querySelector("[data-google-connect]");
    const disconnectBtn = wrapper.querySelector("[data-google-disconnect]");
    const updateStatus = async () => {
      try {
        const res = await fetch(new URL("googleapis/auth/status", location.href));
        const data = res.ok ? await res.json() : { connected: false };
        if (data.connected) {
          statusEl.textContent = "Connected";
          connectBtn.style.display = "none";
          disconnectBtn.style.display = "";
        } else {
          statusEl.textContent = "Not connected";
          connectBtn.style.display = "";
          disconnectBtn.style.display = "none";
        }
      } catch {
        statusEl.textContent = "Status unavailable";
      }
    };
    connectBtn.addEventListener("click", () => {
      const popup = window.open(new URL("googleapis/auth/start", location.href), "_blank", "width=520,height=640");
      const poll = setInterval(() => {
        if (popup?.closed) {
          clearInterval(poll);
          updateStatus();
        }
      }, 500);
    });
    disconnectBtn.addEventListener("click", async () => {
      await fetch(new URL("googleapis/auth/revoke", location.href), { method: "POST" });
      updateStatus();
    });
    updateStatus();
  }
  firstUpdated() {
    this.querySelectorAll('[data-widget="google-account"]').forEach((el) => {
      el.dispatchEvent(new CustomEvent("hook-google-status", { bubbles: false }));
    });
  }
  updated() {
    this.querySelectorAll('[data-widget="google-account"]').forEach((el) => {
      if (!el._initialized) {
        el._initialized = true;
        el.dispatchEvent(new CustomEvent("hook-google-status", { bubbles: false }));
      }
    });
  }
  _inferWidget(schema) {
    if (schema.type === "boolean")
      return "toggle";
    if (schema.type === "number")
      return "number";
    if (schema.enum)
      return "select";
    return "text";
  }
  _gatherValuesByPlugin() {
    const byPlugin = {};
    this.querySelectorAll("[data-config-key]").forEach((el) => {
      if (el.dataset.widget === "google-account")
        return;
      const pluginId = el.dataset.section.split(".")[0];
      const configKey = el.dataset.configKey;
      const key = el.name;
      if (!key)
        return;
      const value = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
      byPlugin[pluginId] ??= {};
      if (configKey) {
        const parts = configKey.split(".");
        let target = byPlugin[pluginId];
        for (let i = 0;i < parts.length; i++) {
          target = target[parts[i]] ??= {};
        }
        target[key] = value;
      } else {
        byPlugin[pluginId][key] = value;
      }
    });
    return byPlugin;
  }
  _flashSaved() {
    const flash = this.querySelector("#flash-msg");
    if (flash)
      flash.save();
  }
  _flashError(msg) {
    const flash = this.querySelector("#flash-msg");
    if (flash)
      flash.error(msg);
  }
}
__legacyDecorateClassTS([
  state()
], RConfigForm.prototype, "schemas", undefined);
__legacyDecorateClassTS([
  state()
], RConfigForm.prototype, "currentValues", undefined);
__legacyDecorateClassTS([
  state()
], RConfigForm.prototype, "models", undefined);
__legacyDecorateClassTS([
  state()
], RConfigForm.prototype, "activeTab", undefined);
RConfigForm = __legacyDecorateClassTS([
  customElement("r-config-form")
], RConfigForm);
// src/frontend/components/r-force-graph.ts
var LABEL_COLORS = {
  Entity: { stroke: "#00c4d4" },
  Project: { stroke: "#c4843a" },
  Concept: { stroke: "#a064dc" },
  Preference: { stroke: "#e06030" },
  Goal: { stroke: "#39e8a0" },
  Place: { stroke: "#50b464" },
  Event: { stroke: "#5ba0b8" },
  Habit: { stroke: "#dcb428" }
};
var NODE_BG = "#060e14";
var DEFAULT_STROKE = "#1a3548";

class RForceGraph extends RorschachBase {
  _sim = null;
  static styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 100%;
    }
    svg { width: 100%; height: 100%; }
    .graph-tooltip {
      position: absolute;
      display: none;
      background: var(--surface-2, #0a1820);
      border: 1px solid var(--border-mid, #1a3548);
      border-radius: var(--radius, 8px);
      padding: 0.5rem;
      font-size: 0.65rem;
      font-family: var(--font-mono, monospace);
      color: var(--text, #e8f6fa);
      pointer-events: none;
      z-index: 10;
      max-width: 260px;
    }
    .graph-tooltip strong { display: block; margin-bottom: 0.25rem; color: var(--accent, #00c4d4); }
    .graph-tooltip pre { margin: 0; white-space: pre-wrap; font-size: 0.6rem; color: var(--text-dim, #3d6878); }
    .plan-node rect { fill: var(--surface, #060e14); stroke: var(--border-mid, #1a3548); stroke-width: 1.5; }
    .plan-node.selected rect { stroke: var(--accent, #00c4d4); stroke-width: 2; }
    .plan-node text { fill: var(--text, #e8f6fa); }
  `;
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._sim) {
      this._sim.stop();
      this._sim = null;
    }
  }
  renderKnowledgeGraph(graph) {
    if (this._sim)
      this._sim.stop();
    this.shadowRoot.innerHTML = "";
    const { nodes, edges } = graph;
    if (nodes.length === 0) {
      this.shadowRoot.innerHTML = `<slot><r-empty-state variant="panel" name="network" text="no graph data"></r-empty-state></slot>`;
      return;
    }
    const host = this.shadowRoot.host;
    const width = host.clientWidth || 600;
    const height = host.clientHeight || 400;
    const R = 22;
    const simNodes = nodes.map((n) => ({ ...n }));
    const nodeById = Object.fromEntries(simNodes.map((n) => [n.id, n]));
    const simEdges = edges.map((e) => ({ ...e, source: nodeById[e.source], target: nodeById[e.target] })).filter((e) => e.source && e.target);
    const svg2 = d3.select(this.shadowRoot).append("svg").attr("width", "100%").attr("height", "100%");
    svg2.append("defs").append("marker").attr("id", "kg-arrow").attr("viewBox", "0 -4 8 8").attr("refX", 8).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto").append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", "#00c4d4");
    const g = svg2.append("g");
    svg2.call(d3.zoom().scaleExtent([0.15, 5]).on("zoom", (ev) => g.attr("transform", ev.transform)));
    const edgeLine = g.append("g").selectAll("line").data(simEdges).enter().append("line").attr("stroke", "#00c4d4").attr("stroke-width", 1.5).attr("marker-end", "url(#kg-arrow)");
    const edgeLabel = g.append("g").selectAll("text").data(simEdges).enter().append("text").text((d2) => d2.type).attr("font-size", "9px").attr("fill", "#2a5468").attr("text-anchor", "middle").attr("font-family", "var(--font-mono)").attr("pointer-events", "none");
    const tooltip = d3.select(this.shadowRoot).append("div").attr("class", "graph-tooltip");
    const nodeGroup = g.append("g").selectAll("g").data(simNodes).enter().append("g").attr("cursor", "grab").call(d3.drag().on("start", (ev, d2) => {
      if (!ev.active)
        sim.alphaTarget(0.3).restart();
      d2.fx = d2.x;
      d2.fy = d2.y;
    }).on("drag", (ev, d2) => {
      d2.fx = ev.x;
      d2.fy = ev.y;
    }).on("end", (ev, d2) => {
      if (!ev.active)
        sim.alphaTarget(0);
      d2.fx = null;
      d2.fy = null;
    }));
    nodeGroup.append("circle").attr("r", R).attr("fill", () => NODE_BG).attr("stroke", (d2) => (LABEL_COLORS[d2.labels[0]] || { stroke: DEFAULT_STROKE }).stroke).attr("stroke-width", 1.5);
    nodeGroup.append("text").text((d2) => String(d2.properties.name || d2.properties.topic || `#${d2.id}`).slice(0, 12)).attr("text-anchor", "middle").attr("dy", "0.35em").attr("font-size", "10px").attr("fill", "#d8eef5").attr("font-family", "var(--font-mono)").attr("pointer-events", "none");
    nodeGroup.append("text").text((d2) => d2.labels[0] || "").attr("text-anchor", "middle").attr("dy", R + 14 + "px").attr("font-size", "8px").attr("fill", "#3d6878").attr("font-family", "var(--font-mono)").attr("pointer-events", "none");
    nodeGroup.on("mouseover", (ev, d2) => {
      const lines = Object.entries(d2.properties).map(([k, v]) => `${k}: ${v}`).join(`
`);
      tooltip.style("display", "block").html(`<strong>${escHtml(d2.labels.join(" · "))}</strong><pre>${escHtml(lines)}</pre>`);
    }).on("mousemove", (ev) => {
      tooltip.style("left", ev.clientX - host.getBoundingClientRect().left + 14 + "px").style("top", ev.clientY - host.getBoundingClientRect().top - 14 + "px");
    }).on("mouseout", () => tooltip.style("display", "none"));
    const connectedIds = new Set(simEdges.flatMap((e) => [e.source.id, e.target.id]));
    const isOrphan = (d2) => !connectedIds.has(d2.id);
    const sim = d3.forceSimulation(simNodes).force("link", d3.forceLink(simEdges).id((d2) => d2.id).distance(130)).force("charge", d3.forceManyBody().strength(-200)).force("center", d3.forceCenter(width / 2, height / 2)).force("x", d3.forceX(width / 2).strength(0.05)).force("y", d3.forceY(height / 2).strength(0.05)).force("collide", d3.forceCollide(R + 18)).force("orphan-x", d3.forceX(width / 2).strength((d2) => isOrphan(d2) ? 0.15 : 0)).force("orphan-y", d3.forceY(height / 2).strength((d2) => isOrphan(d2) ? 0.15 : 0)).on("tick", () => {
      edgeLine.attr("x1", (d2) => d2.source.x).attr("y1", (d2) => d2.source.y).attr("x2", (d2) => {
        const dx = d2.target.x - d2.source.x, dy = d2.target.y - d2.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        return d2.target.x - dx / dist * (R + 10);
      }).attr("y2", (d2) => {
        const dx = d2.target.x - d2.source.x, dy = d2.target.y - d2.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        return d2.target.y - dy / dist * (R + 10);
      });
      edgeLabel.attr("x", (d2) => {
        const dx = d2.target.x - d2.source.x, dy = d2.target.y - d2.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        return d2.source.x + dx / dist * (R + 25);
      }).attr("y", (d2) => {
        const dx = d2.target.x - d2.source.x, dy = d2.target.y - d2.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        return d2.source.y + dy / dist * (R + 25);
      }).attr("text-anchor", (d2) => d2.target.x > d2.source.x ? "start" : "end");
      nodeGroup.attr("transform", (d2) => `translate(${d2.x},${d2.y})`);
    });
    this._sim = sim;
  }
  renderPlanGraph(graph, selectedId, onSelect) {
    if (this._sim)
      this._sim.stop();
    this.shadowRoot.innerHTML = "";
    if (!graph.nodes.length) {
      this.shadowRoot.innerHTML = `<slot><div class="plan-empty"><span>plan has no tasks</span></div></slot>`;
      return;
    }
    const host = this.shadowRoot.host;
    const width = Math.max(host.clientWidth, 320);
    const height = Math.max(host.clientHeight, 260);
    const nodeById = Object.fromEntries(graph.nodes.map((node2) => [node2.id, { ...node2 }]));
    const nodes = Object.values(nodeById);
    const edges = graph.edges.map((edge) => ({ ...edge, source: nodeById[edge.source], target: nodeById[edge.target] })).filter((edge) => edge.source && edge.target);
    let currentSelected = selectedId;
    const svg2 = d3.select(this.shadowRoot).append("svg").attr("width", "100%").attr("height", "100%");
    svg2.append("defs").append("marker").attr("id", "plan-arrow").attr("viewBox", "0 -4 8 8").attr("refX", 8).attr("refY", 0).attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto").append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", "#00c4d4");
    const g = svg2.append("g");
    svg2.call(d3.zoom().scaleExtent([0.25, 4]).on("zoom", (ev) => g.attr("transform", ev.transform)));
    const link = g.append("g").selectAll("line").data(edges).enter().append("line").attr("stroke", "#1e5264").attr("stroke-width", 1.4).attr("marker-end", "url(#plan-arrow)");
    const shortLabel = (value, max = 18) => {
      const text = String(value || "");
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    };
    const node = g.append("g").selectAll("g").data(nodes).enter().append("g").attr("class", (d2) => "plan-node" + (d2.id === currentSelected ? " selected" : "")).attr("cursor", "pointer").call(d3.drag().on("start", (ev, d2) => {
      if (!ev.active)
        sim.alphaTarget(0.3).restart();
      d2.fx = d2.x;
      d2.fy = d2.y;
    }).on("drag", (ev, d2) => {
      d2.fx = ev.x;
      d2.fy = ev.y;
    }).on("end", (ev, d2) => {
      if (!ev.active)
        sim.alphaTarget(0);
      d2.fx = null;
      d2.fy = null;
    })).on("click", (_ev, d2) => {
      currentSelected = d2.id;
      node.attr("class", (n) => "plan-node" + (n.id === currentSelected ? " selected" : ""));
      if (onSelect)
        onSelect(d2.id);
    });
    node.append("rect").attr("x", -62).attr("y", -22).attr("width", 124).attr("height", 44).attr("rx", 6);
    node.append("text").text((d2) => shortLabel(d2.label)).attr("text-anchor", "middle").attr("dy", "0.3em").attr("font-size", "10px").attr("font-family", "var(--font-mono)");
    const sim = d3.forceSimulation(nodes).force("link", d3.forceLink(edges).id((d2) => d2.id).distance(135).strength(0.7)).force("charge", d3.forceManyBody().strength(-320)).force("center", d3.forceCenter(width / 2, height / 2)).force("x", d3.forceX(width / 2).strength(0.06)).force("y", d3.forceY(height / 2).strength(0.08)).force("collide", d3.forceCollide(76)).on("tick", () => {
      link.attr("x1", (d2) => d2.source.x).attr("y1", (d2) => d2.source.y).attr("x2", (d2) => {
        const dx = d2.target.x - d2.source.x;
        const dy = d2.target.y - d2.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        return d2.target.x - dx / dist * 68;
      }).attr("y2", (d2) => {
        const dx = d2.target.x - d2.source.x;
        const dy = d2.target.y - d2.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        return d2.target.y - dy / dist * 28;
      });
      node.attr("transform", (d2) => `translate(${d2.x},${d2.y})`);
    });
    this._sim = sim;
  }
  render() {
    return html`<slot><r-empty-state variant="panel" name="network" text="no graph data"></r-empty-state></slot>`;
  }
}
RForceGraph = __legacyDecorateClassTS([
  customElement("r-force-graph")
], RForceGraph);
// src/frontend/components/r-plan-workspace.ts
class RPlanWorkspace extends RorschachBase {
  _currentGraph = null;
  _selectedTaskId = null;
  _isResizing = false;
  _WIDTH_KEY = "rorschach.planWorkspaceWidth";
  _DEFAULT_WIDTH = 460;
  _MIN_WIDTH = 320;
  _MIN_CHAT_WIDTH = 360;
  _unsubMode = null;
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this._bindEvents();
    this._unsubMode = store.subscribe("currentMode", (mode) => {
      if (mode === "executor")
        this.openList();
      else
        this.close();
    });
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubMode?.();
    this._unsubMode = null;
  }
  async openList() {
    this._setOpen(true);
    this._setTitle("Plans");
    const bodyEl = this.querySelector(".plan-workspace-body");
    if (bodyEl)
      bodyEl.innerHTML = this._emptyPanel("loading plans");
    try {
      this._renderPlanList(await this._fetchJson("plans"));
    } catch {
      if (bodyEl)
        bodyEl.innerHTML = this._emptyPanel("could not load plans");
    }
  }
  async openGraph(planId) {
    this._setOpen(true);
    this._setTitle("Plan");
    const bodyEl = this.querySelector(".plan-workspace-body");
    if (bodyEl)
      bodyEl.innerHTML = this._emptyPanel("loading graph");
    try {
      this._renderGraph(await this._fetchJson(`plans/${encodeURIComponent(planId)}/graph`));
    } catch {
      if (bodyEl)
        bodyEl.innerHTML = this._emptyPanel("could not load graph");
    }
  }
  close() {
    this._setOpen(false);
  }
  get _panel() {
    return this.closest("#panel-chat");
  }
  _maxWorkspaceWidth() {
    const panelWidth = this._panel?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.max(this._MIN_WIDTH, Math.min(760, panelWidth - this._MIN_CHAT_WIDTH));
  }
  _clampWidth(width) {
    return Math.max(this._MIN_WIDTH, Math.min(this._maxWorkspaceWidth(), width));
  }
  _savedWidth() {
    const raw = localStorage.getItem(this._WIDTH_KEY);
    const parsed = raw ? Number(raw) : this._DEFAULT_WIDTH;
    return Number.isFinite(parsed) ? this._clampWidth(parsed) : this._DEFAULT_WIDTH;
  }
  _applyWidth(width) {
    const next = this._clampWidth(width);
    this._panel?.style.setProperty("--plan-workspace-width", `${next}px`);
    return next;
  }
  _setOpen(open) {
    this._panel?.classList.toggle("plan-workspace-open", open);
    if (open)
      this._applyWidth(this._savedWidth());
  }
  _setTitle(text) {
    const titleEl = this.querySelector(".plan-workspace-title");
    if (titleEl)
      titleEl.textContent = text;
  }
  _emptyPanel(text) {
    return `<div class="plan-empty"><span>${escHtml(text)}</span></div>`;
  }
  render() {
    return html`
      <div class="plan-workspace-resizer" role="separator" aria-orientation="vertical" aria-label="Resize plan workspace"></div>
      <aside class="plan-workspace" aria-label="Plan workspace">
        <div class="plan-workspace-header">
          <div>
            <div class="plan-workspace-kicker">Executor</div>
            <h2 class="plan-workspace-title">Plans</h2>
          </div>
          <button class="plan-workspace-close" aria-label="Close plan workspace" @click=${this.close}>×</button>
        </div>
        <div class="plan-workspace-body"></div>
      </aside>
    `;
  }
  _bindEvents() {}
  firstUpdated() {
    const resizer = this.querySelector(".plan-workspace-resizer");
    if (!resizer)
      return;
    resizer.addEventListener("pointerdown", (event) => {
      if (!this._panel?.classList.contains("plan-workspace-open"))
        return;
      this._isResizing = true;
      resizer.setPointerCapture(event.pointerId);
      document.body.classList.add("plan-workspace-resizing");
      event.preventDefault();
    });
    resizer.addEventListener("pointermove", (event) => {
      if (!this._isResizing || !this._panel)
        return;
      const rect = this._panel.getBoundingClientRect();
      const width = this._applyWidth(rect.right - event.clientX);
      localStorage.setItem(this._WIDTH_KEY, String(width));
    });
    const finishResize = (event) => {
      if (!this._isResizing)
        return;
      this._isResizing = false;
      document.body.classList.remove("plan-workspace-resizing");
      if (event.pointerId !== undefined && resizer?.hasPointerCapture(event.pointerId)) {
        resizer.releasePointerCapture(event.pointerId);
      }
      if (this._currentGraph)
        this._renderGraph(this._currentGraph);
    };
    resizer.addEventListener("pointerup", finishResize);
    resizer.addEventListener("pointercancel", finishResize);
    window.addEventListener("resize", () => {
      if (!this._panel?.classList.contains("plan-workspace-open"))
        return;
      const width = this._applyWidth(this._savedWidth());
      localStorage.setItem(this._WIDTH_KEY, String(width));
      if (this._currentGraph)
        this._renderGraph(this._currentGraph);
    });
  }
  async _fetchJson(path) {
    const res = await fetch(new URL(path, location.href));
    if (!res.ok)
      throw new Error(await res.text());
    return await res.json();
  }
  _formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  }
  _renderPlanList(plans) {
    this._currentGraph = null;
    this._selectedTaskId = null;
    this._setTitle("Plans");
    const bodyEl = this.querySelector(".plan-workspace-body");
    if (!bodyEl)
      return;
    if (!plans.length) {
      bodyEl.innerHTML = this._emptyPanel("no saved plans");
      return;
    }
    const list = document.createElement("div");
    list.className = "plan-list";
    for (const plan of plans) {
      const btn = document.createElement("button");
      btn.className = "plan-list-item";
      btn.type = "button";
      btn.dataset.planId = plan.id;
      btn.innerHTML = `
        <span class="plan-list-goal">${escHtml(plan.goal)}</span>
        <span class="plan-list-meta">${escHtml(this._formatDate(plan.createdAt))} · ${plan.taskCount} task${plan.taskCount === 1 ? "" : "s"}</span>
      `;
      btn.addEventListener("click", () => this.openGraph(plan.id));
      list.appendChild(btn);
    }
    bodyEl.replaceChildren(list);
  }
  _taskById(id) {
    return this._currentGraph?.nodes.find((node) => node.id === id) ?? null;
  }
  _renderTaskDetail(task) {
    const detail = document.createElement("div");
    detail.className = "plan-task-detail";
    if (!task) {
      detail.innerHTML = '<div class="plan-task-placeholder">Select a task to inspect details.</div>';
      return detail;
    }
    const deps = task.dependencies.length ? task.dependencies.map((id) => this._taskById(id)?.label || id).join(", ") : "none";
    const dependents = task.dependents.length ? task.dependents.map((id) => this._taskById(id)?.label || id).join(", ") : "none";
    detail.innerHTML = `
      <div class="plan-task-status">status · not tracked</div>
      <h3>${escHtml(task.label)}</h3>
      <dl>
        <dt>Description</dt>
        <dd>${escHtml(task.description || "No description")}</dd>
        <dt>Validation</dt>
        <dd>${escHtml(task.validationCriteria || "No validation criteria")}</dd>
        <dt>Depends on</dt>
        <dd>${escHtml(deps)}</dd>
        <dt>Unlocks</dt>
        <dd>${escHtml(dependents)}</dd>
      </dl>
    `;
    return detail;
  }
  _renderGraph(graph) {
    const nextSelectedTaskId = this._selectedTaskId;
    this._currentGraph = graph;
    this._selectedTaskId = graph.nodes.some((node) => node.id === nextSelectedTaskId) ? nextSelectedTaskId : graph.nodes[0]?.id ?? null;
    this._setTitle(graph.plan.goal);
    const bodyEl = this.querySelector(".plan-workspace-body");
    if (!bodyEl)
      return;
    const shell = document.createElement("div");
    shell.className = "plan-graph-shell";
    const meta = document.createElement("div");
    meta.className = "plan-graph-meta";
    meta.textContent = `${this._formatDate(graph.plan.createdAt)} · ${graph.plan.taskCount} task${graph.plan.taskCount === 1 ? "" : "s"}`;
    const graphEl = document.createElement("r-force-graph");
    graphEl.className = "plan-graph";
    const detailWrap = document.createElement("div");
    detailWrap.className = "plan-task-detail-wrap";
    shell.append(meta, graphEl, detailWrap);
    bodyEl.replaceChildren(shell);
    const updateDetail = () => {
      detailWrap.replaceChildren(this._renderTaskDetail(this._taskById(this._selectedTaskId)));
    };
    updateDetail();
    if (!graph.nodes.length) {
      graphEl.innerHTML = this._emptyPanel("plan has no tasks");
      return;
    }
    graphEl.renderPlanGraph(graph, this._selectedTaskId, (id) => {
      this._selectedTaskId = id;
      updateDetail();
    });
  }
}
RPlanWorkspace = __legacyDecorateClassTS([
  customElement("r-plan-workspace")
], RPlanWorkspace);
// src/frontend/corona.ts
var voidCanvas = document.getElementById("void-canvas");
var voidRaf = null;
var VERT_SRC = `
  attribute vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;
var FRAG_SRC = `
  precision highp float;
  uniform vec2  u_res;
  uniform float u_time;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1,0)), f.x),
      mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x),
      f.y
    );
  }

  float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
    float r  = length(uv);
    float ag = atan(uv.y, uv.x);
    float t  = u_time * 0.18;   // faster base speed

    const float MOON = 0.185;

    // Deep space — near-total dark during totality
    vec3 col = vec3(0.001, 0.002, 0.015);

    // Stars — more visible during eclipse
    for (int i = 0; i < 2; i++) {
      float scale = 40.0 + float(i) * 24.0;
      vec2  sg    = uv * scale + vec2(float(i) * 17.3, float(i) * 9.1);
      float s     = hash(floor(sg));
      if (s > 0.962) {
        vec2  sp = fract(sg) - 0.5;
        float sr = length(sp);
        float sb = smoothstep(0.2, 0.0, sr) * (s - 0.962) * 26.0;
        float tw = 0.75 + 0.25 * sin(u_time * (1.0 + float(i) * 0.6) + s * 31.4);
        col += vec3(0.88, 0.92, 1.0) * sb * tw;
      }
    }

    // Angle unit vector — avoids atan seam for noise sampling
    vec2 angVec = vec2(cos(ag), sin(ag));

    // Angular noise — each layer evolves at a distinct rate
    float aN1 = fbm3(angVec * 2.8 + t * 0.14);
    float aN2 = fbm3(angVec * 4.5 - t * 0.09 + 1.3);
    float aN3 = fbm3(angVec * 1.6 + vec2(t * 0.07, -t * 0.11) + 2.7);
    float aN4 = fbm3(angVec * 6.0 + t * 0.06 + 5.2);   // fine high-freq layer

    // Streamer rays — high powers create sharp bright rays against dark gaps
    float s1 = 0.5 + 0.5 * cos(ag *  3.0 + aN1 * 3.2);
    float s2 = 0.5 + 0.5 * cos(ag *  5.0 + aN2 * 2.8 + 1.3);
    float s3 = 0.5 + 0.5 * cos(ag *  7.0 + aN3 * 2.0 - 0.8);
    float s4 = 0.5 + 0.5 * cos(ag * 11.0 + aN4 * 1.5 + 2.1);
    float streamer = pow(s1,  6.0) * 0.44
                   + pow(s2,  8.0) * 0.30
                   + pow(s3, 10.0) * 0.16
                   + pow(s4, 12.0) * 0.10;

    // Radial corona falloffs
    float coronaR   = max(0.0, r - MOON);
    float innerFall = exp(-14.0 * coronaR) * smoothstep(MOON, MOON + 0.004, r);
    float outerFall = exp(-2.5  * coronaR) * smoothstep(MOON, MOON + 0.015, r);

    // Fine radial fibre texture
    float radTex = fbm3(uv * 5.5 + vec2(t * 0.14, t * 0.11));

    // Pulsing heartbeat on inner corona
    float pulse = 0.75 + 0.25 * sin(u_time * .8) * sin(u_time * 0.1);

    float innerCorona = innerFall * (0.60 + 0.40 * radTex) * pulse;

    // Each streamer glows up and down independently via angle-based phase offset
    float stPulse = 0.50 + 0.50 * sin(u_time * 0.75 + aN1 * 6.28)
                                * sin(u_time * 0.40 - aN2 * 4.00 + 1.3);
    // Near-black in gaps, bright on streamer peaks
    float outerCorona = outerFall * (0.04 + 0.96 * streamer * streamer) * stPulse;

    // Chromosphere — thin warm ring at the solar limb
    float chromo = smoothstep(MOON - 0.002, MOON + 0.001, r)
                 * smoothstep(MOON + 0.014, MOON + 0.004, r);

    // Prominences — two independent noise layers, larger and faster
    float promN1   = fbm5(angVec * 4.0 + t * 0.35);
    float promN2   = fbm3(angVec * 2.5 - t * 0.28 + 3.7);
    float promRing = smoothstep(MOON, MOON + 0.006, r) * smoothstep(MOON + 0.07, MOON + 0.015, r);
    float prom     = promRing * (pow(max(0.0, promN1 - 0.28) / 0.72, 2.0) * 3.5
                               + pow(max(0.0, promN2 - 0.35) / 0.65, 2.5) * 2.5);

    // Colors
    vec3 coronaWarm = vec3(1.00, 0.97, 0.88);   // warm white inner corona
    vec3 coronaCool = vec3(0.80, 0.90, 1.00);   // silver-blue outer streamers
    vec3 chromoCol  = vec3(1.00, 0.92, 0.60);   // warm amber chromosphere
    vec3 promColor  = vec3(0.98, 0.18, 0.12);   // H-alpha red prominence

    float outerBlend = smoothstep(MOON, MOON + 0.5, r);

    col += coronaWarm                              * innerCorona * 3.5;
    col += mix(coronaWarm, coronaCool, outerBlend) * outerCorona * 2.2;
    col += chromoCol * chromo * 1.6;
    col += promColor * prom;

    // Moon — absolute black occluder
    float moon = smoothstep(MOON + 0.003, MOON, r);
    col *= 1.0 - moon;

    // Filmic tone-map
    col = col / (col + 0.55);
    col = pow(col, vec3(0.9));

    gl_FragColor = vec4(col, 1.0);
  }
`;
function initVoidGL() {
  if (!voidCanvas)
    return null;
  const gl = voidCanvas.getContext("webgl");
  if (!gl)
    return null;
  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, "u_res");
  const uTime = gl.getUniformLocation(prog, "u_time");
  return { gl, uRes, uTime };
}
function resizeVoidCanvas() {
  if (!voidCanvas)
    return;
  voidCanvas.width = Math.ceil(window.innerWidth * 0.5);
  voidCanvas.height = Math.ceil(window.innerHeight * 0.5);
}
if (voidCanvas) {
  resizeVoidCanvas();
  const voidGL = initVoidGL();
  if (voidGL) {
    const { gl, uRes, uTime } = voidGL;
    const t0 = performance.now();
    let lastFrameTs = 0;
    const drawVoidFrame = (ts) => {
      voidRaf = requestAnimationFrame(drawVoidFrame);
      if (ts - lastFrameTs < 33)
        return;
      lastFrameTs = ts;
      gl.viewport(0, 0, voidCanvas.width, voidCanvas.height);
      gl.uniform2f(uRes, voidCanvas.width, voidCanvas.height);
      gl.uniform1f(uTime, (performance.now() - t0) * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (voidRaf)
          cancelAnimationFrame(voidRaf);
        voidRaf = null;
      } else if (!voidRaf) {
        voidRaf = requestAnimationFrame(drawVoidFrame);
      }
    });
    window.addEventListener("resize", () => {
      resizeVoidCanvas();
      gl.viewport(0, 0, voidCanvas.width, voidCanvas.height);
    }, { passive: true });
    voidRaf = requestAnimationFrame(drawVoidFrame);
  }
}

// src/frontend/connection.ts
var logoutBtn = document.getElementById("logout-btn");
logoutBtn?.addEventListener("click", async () => {
  await fetch(new URL("auth/logout", location.href), { method: "POST" });
  window.location.href = new URL("auth/login.html", location.href).href;
});
var wsMessageFrameTypes = new Set([
  "chunk",
  "done",
  "error",
  "tooling",
  "sources",
  "attachments",
  "reasoningChunk",
  "plannerMode",
  "modeChanged",
  "agents"
]);
var targetFrameHandlers = {
  planGraph: dispatchTo("r-plan-workspace", "plan-graph"),
  usage: callObserve("handleUsage"),
  log: callObserve("handleLog"),
  metrics: callObserve("handleMetrics"),
  trace: callObserve("handleTrace"),
  tool_registered: callObserve("handleToolRegistered"),
  tool_unregistered: callObserve("handleToolUnregistered")
};
function dispatchTo(selector, eventName) {
  return (msg) => {
    document.querySelector(selector)?.dispatchEvent(new CustomEvent(eventName, { detail: msg, bubbles: true }));
  };
}
function callObserve(methodName) {
  return (msg) => {
    document.querySelector("r-observe-panel")?.[methodName]?.(msg);
  };
}
function dispatchFrame(msg) {
  if (wsMessageFrameTypes.has(msg.type)) {
    document.dispatchEvent(new CustomEvent("ws-message", { detail: msg, bubbles: true }));
    return;
  }
  targetFrameHandlers[msg.type]?.(msg);
}
async function connect() {
  const wsUrl = new URL("ws", location.href);
  wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    const ticketRes = await fetch(new URL("auth/ticket", location.href), { method: "POST" });
    if (ticketRes.status === 401) {
      window.location.href = new URL("auth/login.html", location.href).href;
      return;
    }
    if (ticketRes.ok) {
      const { ticket } = await ticketRes.json();
      wsUrl.searchParams.set("ticket", ticket);
    }
  } catch (e) {
    console.warn("Authentication ticket fetch failed, attempting connection anyway.", e);
  }
  const ws = new WebSocket(wsUrl.href);
  store.set("ws", ws);
  ws.addEventListener("open", () => {
    store.set("isConnected", true);
    const chatTab = document.querySelector('[data-tab="chat"].active');
    if (chatTab) {
      document.getElementById("input")?.focus();
    }
  });
  ws.addEventListener("close", () => {
    store.set("isConnected", false);
    store.set("isWaiting", false);
    setTimeout(connect, 2000);
  });
  ws.addEventListener("error", () => ws.close());
  ws.addEventListener("message", (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    dispatchFrame(msg);
  });
}

// src/frontend/tabs.ts
var tabBtns = document.querySelectorAll("[data-tab]");
var logoSub = document.getElementById("logo-sub");
function activateTab(tab) {
  const btn = document.querySelector(`[data-tab="${tab}"]`);
  const panel = document.getElementById("panel-" + tab);
  if (!btn || !panel)
    return;
  tabBtns.forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  panel.classList.add("active");
  if (logoSub)
    logoSub.textContent = tab;
  if (tab === "chat" && store.get("isConnected")) {
    document.querySelector("r-chat-input")?.shadowRoot?.querySelector("textarea")?.focus();
  }
}
function setTabVisible(tab, visible) {
  const btn = document.querySelector(`[data-tab="${tab}"]`);
  if (!btn)
    return;
  btn.hidden = !visible;
  if (!visible && btn.classList.contains("active"))
    activateTab("chat");
}
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    if (tab)
      activateTab(tab);
  });
});

// src/frontend/rorschach.ts
fetch(new URL("me", location.href)).then((r) => r.json()).then(({ userId, roles }) => {
  store.set("currentUserId", userId);
  store.set("currentUserRoles", roles ?? []);
  const roles_ = store.get("currentUserRoles");
  const isAdmin = roles_.includes("admin");
  const isAnonymousMode = userId === "anonymous";
  const canUseAdminSurface = isAnonymousMode || isAdmin;
  setTabVisible("config", canUseAdminSurface);
  setTabVisible("observe", canUseAdminSurface);
  if (canUseAdminSurface)
    document.querySelector("r-config-form")?.loadSchemas();
  if (userId && userId !== "anonymous") {
    const logoutBtn2 = document.getElementById("logout-btn");
    if (logoutBtn2)
      logoutBtn2.style.display = "";
  }
}).catch(() => {
  setTabVisible("config", false);
  setTabVisible("observe", false);
});
store.subscribe("isWaiting", (waiting) => {
  document.querySelector("header")?.classList.toggle("streaming", !!waiting);
});
initSession();
connect();
