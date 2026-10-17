/*
 * Errors about loading, small enough for the first download (the explanations of SQL errors, in
 * errors.ts, load when one is shown).
 */

/** A file whose kind is the problem (a PDF, an image, empty): its message, in plain words, is the whole story. */
export class FileKindError extends Error {}

/** A dynamic import that failed: the file is gone (a new version) or the network is. */
export const isLoadFailure = (e: Error) => /dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i.test(e.message)
