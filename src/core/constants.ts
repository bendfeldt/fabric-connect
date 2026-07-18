/**
 * Explicit API constants. The Fabric REST API version is a stated constant,
 * never inferred from response shape.
 */

export const FABRIC_API_BASE_URL = 'https://api.fabric.microsoft.com/v1';

/** Livy API version segment used by Fabric Lakehouse Livy endpoints. */
export const LIVY_API_VERSION = '2023-12-01';

/**
 * Least-privilege delegated scope for the Fabric REST + Livy APIs. We
 * deliberately do not request broad Graph or management scopes.
 */
export const FABRIC_SCOPES: readonly string[] = [
  'https://api.fabric.microsoft.com/.default',
];
