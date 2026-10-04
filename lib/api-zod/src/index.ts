export * from "./generated/api";
export * from "./generated/types";
// An endpoint with both a path id and a query parameter gets two generated
// things with one name: the zod schema for the path params, and the TypeScript
// type for the query params. The schema is the one the server parses with, so
// it is named here and the ambiguity goes away.
export { GetServiceAssignedImpactParams } from "./generated/api";
