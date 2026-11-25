// The SIREN is the only value that comes from outside. A Siren can only be made by
// parseSiren, so a string that was not checked does not compile as an argument of the job.
export type Siren = string & { readonly __brand: "Siren" };

export function parseSiren(input: string): Siren {
  if (!/^\d{9}$/.test(input)) {
    throw new Error(`Not a SIREN, 9 digits expected: ${JSON.stringify(input)}`);
  }
  return input as Siren;
}
