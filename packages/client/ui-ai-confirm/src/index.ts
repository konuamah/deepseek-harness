/**
 * AI confirm card plugin, node half. Pure UI plugin: the empty apply exists so
 * the plugin appears in the host cordis.yml / Loader; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client declaration.
 */

/** Host plugin body: this plugin has no host-side behavior. */
export function apply(): void {}
