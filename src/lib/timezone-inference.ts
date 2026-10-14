/**
 * Which IANA timezone a person is in, read off what we hold about them (PUSHED-PERSON-TZ-1014,
 * owner 2026-10-14). Pure: no IO. The writer and its precedence live in `lead-timezone.ts`.
 *
 * Why: a person a client PUSHES (email / name / phone) has no enrichment, so the senders fell back to
 * America/Chicago and booked a UK employer's emails at 13:00-01:00 UK. An inferred zone is used only
 * when nobody STATED one and the enrichment carries none.
 *
 * Signals, strongest first, each naming a COUNTRY and, when the country (or its state / province)
 * keeps one clock for nearly all its people, a ZONE:
 *   1. lead_location     the person's own country (+ state), from the enrichment
 *   2. phone_country     the calling code of an international (+ / 00) number
 *   3. company_location  the employer's country (+ state)
 *   4. email_domain      the address's country-code domain (marie@acme.co.uk -> GB)
 * The FIRST signal that names a country fixes the country; the zone is the first zone any signal gives
 * IN THAT COUNTRY (a US person with no state and an employer in Texas reads America/Chicago; a US
 * person with a .co.uk address reads nothing, never London). A country of several clocks with no state
 * that settles it is unknown: null, never a guess. NANP (+1) and +7 numbers name no single country.
 */

export type TimezoneBasis = "lead_location" | "phone_country" | "company_location" | "email_domain";

export interface TimezoneSignals {
  leadCountry?: string | null;
  leadState?: string | null;
  companyCountry?: string | null;
  companyState?: string | null;
  phones?: readonly string[];
  emails?: readonly string[];
}

export interface InferredTimezone {
  timezone: string;
  basis: TimezoneBasis;
  country: string;
}

interface CountryRow {
  iso2: string;
  /** The zone for the whole country, or null when several clocks split its people. */
  zone: string | null;
  /** International calling code, digits only; null when shared (NANP +1, +7). */
  callingCode: string | null;
  names: string[];
}

// [iso2, zone | null, calling code | null, ...extra names]
const COUNTRY_DATA: Array<[string, string | null, string | null, ...string[]]> = [
  // Europe
  ["GB", "Europe/London", "44", "United Kingdom", "UK", "Great Britain", "England", "Scotland", "Wales", "Northern Ireland", "Britain"],
  ["IE", "Europe/Dublin", "353", "Ireland", "Republic of Ireland"],
  ["FR", "Europe/Paris", "33", "France"],
  ["DE", "Europe/Berlin", "49", "Germany", "Deutschland"],
  ["ES", "Europe/Madrid", "34", "Spain", "España"],
  ["PT", "Europe/Lisbon", "351", "Portugal"],
  ["IT", "Europe/Rome", "39", "Italy", "Italia"],
  ["NL", "Europe/Amsterdam", "31", "Netherlands", "The Netherlands", "Holland"],
  ["BE", "Europe/Brussels", "32", "Belgium"],
  ["LU", "Europe/Luxembourg", "352", "Luxembourg"],
  ["CH", "Europe/Zurich", "41", "Switzerland"],
  ["AT", "Europe/Vienna", "43", "Austria"],
  ["MC", "Europe/Monaco", "377", "Monaco"],
  ["DK", "Europe/Copenhagen", "45", "Denmark"],
  ["SE", "Europe/Stockholm", "46", "Sweden"],
  ["NO", "Europe/Oslo", "47", "Norway"],
  ["FI", "Europe/Helsinki", "358", "Finland"],
  ["IS", "Atlantic/Reykjavik", "354", "Iceland"],
  ["PL", "Europe/Warsaw", "48", "Poland"],
  ["CZ", "Europe/Prague", "420", "Czechia", "Czech Republic"],
  ["SK", "Europe/Bratislava", "421", "Slovakia"],
  ["HU", "Europe/Budapest", "36", "Hungary"],
  ["RO", "Europe/Bucharest", "40", "Romania"],
  ["BG", "Europe/Sofia", "359", "Bulgaria"],
  ["GR", "Europe/Athens", "30", "Greece"],
  ["HR", "Europe/Zagreb", "385", "Croatia"],
  ["SI", "Europe/Ljubljana", "386", "Slovenia"],
  ["RS", "Europe/Belgrade", "381", "Serbia"],
  ["BA", "Europe/Sarajevo", "387", "Bosnia and Herzegovina"],
  ["ME", "Europe/Podgorica", "382", "Montenegro"],
  ["MK", "Europe/Skopje", "389", "North Macedonia", "Macedonia"],
  ["AL", "Europe/Tirane", "355", "Albania"],
  ["EE", "Europe/Tallinn", "372", "Estonia"],
  ["LV", "Europe/Riga", "371", "Latvia"],
  ["LT", "Europe/Vilnius", "370", "Lithuania"],
  ["UA", "Europe/Kyiv", "380", "Ukraine"],
  ["BY", "Europe/Minsk", "375", "Belarus"],
  ["MD", "Europe/Chisinau", "373", "Moldova"],
  ["CY", "Asia/Nicosia", "357", "Cyprus"],
  ["MT", "Europe/Malta", "356", "Malta"],
  ["TR", "Europe/Istanbul", "90", "Turkey", "Türkiye", "Turkiye"],
  ["GE", "Asia/Tbilisi", "995", "Georgia"],
  ["AM", "Asia/Yerevan", "374", "Armenia"],
  ["AZ", "Asia/Baku", "994", "Azerbaijan"],
  ["RU", null, null, "Russia", "Russian Federation"],
  ["KZ", null, null, "Kazakhstan"],
  // Middle East
  ["IL", "Asia/Jerusalem", "972", "Israel"],
  ["AE", "Asia/Dubai", "971", "United Arab Emirates", "UAE"],
  ["SA", "Asia/Riyadh", "966", "Saudi Arabia"],
  ["QA", "Asia/Qatar", "974", "Qatar"],
  ["KW", "Asia/Kuwait", "965", "Kuwait"],
  ["BH", "Asia/Bahrain", "973", "Bahrain"],
  ["OM", "Asia/Muscat", "968", "Oman"],
  ["JO", "Asia/Amman", "962", "Jordan"],
  ["LB", "Asia/Beirut", "961", "Lebanon"],
  ["EG", "Africa/Cairo", "20", "Egypt"],
  ["IR", "Asia/Tehran", "98", "Iran"],
  ["IQ", "Asia/Baghdad", "964", "Iraq"],
  // Asia
  ["IN", "Asia/Kolkata", "91", "India"],
  ["PK", "Asia/Karachi", "92", "Pakistan"],
  ["BD", "Asia/Dhaka", "880", "Bangladesh"],
  ["LK", "Asia/Colombo", "94", "Sri Lanka"],
  ["NP", "Asia/Kathmandu", "977", "Nepal"],
  ["CN", "Asia/Shanghai", "86", "China"],
  ["HK", "Asia/Hong_Kong", "852", "Hong Kong"],
  ["MO", "Asia/Macau", "853", "Macau", "Macao"],
  ["TW", "Asia/Taipei", "886", "Taiwan"],
  ["JP", "Asia/Tokyo", "81", "Japan"],
  ["KR", "Asia/Seoul", "82", "South Korea", "Korea", "Republic of Korea"],
  ["SG", "Asia/Singapore", "65", "Singapore"],
  ["MY", "Asia/Kuala_Lumpur", "60", "Malaysia"],
  ["TH", "Asia/Bangkok", "66", "Thailand"],
  ["VN", "Asia/Ho_Chi_Minh", "84", "Vietnam", "Viet Nam"],
  ["PH", "Asia/Manila", "63", "Philippines"],
  ["KH", "Asia/Phnom_Penh", "855", "Cambodia"],
  ["ID", null, "62", "Indonesia"],
  // Oceania
  ["AU", null, "61", "Australia"],
  ["NZ", "Pacific/Auckland", "64", "New Zealand"],
  // Africa
  ["ZA", "Africa/Johannesburg", "27", "South Africa"],
  ["NG", "Africa/Lagos", "234", "Nigeria"],
  ["KE", "Africa/Nairobi", "254", "Kenya"],
  ["GH", "Africa/Accra", "233", "Ghana"],
  ["MA", "Africa/Casablanca", "212", "Morocco"],
  ["TN", "Africa/Tunis", "216", "Tunisia"],
  ["DZ", "Africa/Algiers", "213", "Algeria"],
  ["ET", "Africa/Addis_Ababa", "251", "Ethiopia"],
  ["UG", "Africa/Kampala", "256", "Uganda"],
  ["TZ", "Africa/Dar_es_Salaam", "255", "Tanzania"],
  ["RW", "Africa/Kigali", "250", "Rwanda"],
  ["SN", "Africa/Dakar", "221", "Senegal"],
  ["CI", "Africa/Abidjan", "225", "Côte d'Ivoire", "Cote d'Ivoire", "Ivory Coast"],
  ["CM", "Africa/Douala", "237", "Cameroon"],
  ["ZW", "Africa/Harare", "263", "Zimbabwe"],
  ["ZM", "Africa/Lusaka", "260", "Zambia"],
  ["MU", "Indian/Mauritius", "230", "Mauritius"],
  // Americas (NANP members share +1: no calling code names them)
  ["US", null, null, "United States", "United States of America", "USA", "U.S.", "U.S.A."],
  ["CA", null, null, "Canada"],
  ["PR", "America/Puerto_Rico", null, "Puerto Rico"],
  ["DO", "America/Santo_Domingo", null, "Dominican Republic"],
  ["JM", "America/Jamaica", null, "Jamaica"],
  ["MX", null, "52", "Mexico", "México"],
  ["BR", null, "55", "Brazil", "Brasil"],
  ["AR", "America/Argentina/Buenos_Aires", "54", "Argentina"],
  ["CL", "America/Santiago", "56", "Chile"],
  ["CO", "America/Bogota", "57", "Colombia"],
  ["PE", "America/Lima", "51", "Peru"],
  ["VE", "America/Caracas", "58", "Venezuela"],
  ["EC", "America/Guayaquil", "593", "Ecuador"],
  ["UY", "America/Montevideo", "598", "Uruguay"],
  ["PY", "America/Asuncion", "595", "Paraguay"],
  ["BO", "America/La_Paz", "591", "Bolivia"],
  ["CR", "America/Costa_Rica", "506", "Costa Rica"],
  ["PA", "America/Panama", "507", "Panama"],
  ["GT", "America/Guatemala", "502", "Guatemala"],
  ["SV", "America/El_Salvador", "503", "El Salvador"],
  ["HN", "America/Tegucigalpa", "504", "Honduras"],
  ["NI", "America/Managua", "505", "Nicaragua"],
];

export const COUNTRIES: CountryRow[] = COUNTRY_DATA.map(([iso2, zone, callingCode, ...names]) => ({
  iso2,
  zone,
  callingCode,
  names,
}));

// The zone most of a state's / province's people live in, for countries of several clocks.
// [iso2 country, zone, ...state names and codes]
const SUBDIVISION_DATA: Array<[string, string, ...string[]]> = [
  ["US", "America/New_York", "Connecticut", "CT", "Delaware", "DE", "District of Columbia", "DC", "Washington DC", "Washington, D.C.",
    "Florida", "FL", "Georgia", "GA", "Indiana", "IN", "Kentucky", "KY", "Maine", "ME", "Maryland", "MD", "Massachusetts", "MA",
    "Michigan", "MI", "New Hampshire", "NH", "New Jersey", "NJ", "New York", "NY", "North Carolina", "NC", "Ohio", "OH",
    "Pennsylvania", "PA", "Rhode Island", "RI", "South Carolina", "SC", "Vermont", "VT", "Virginia", "VA", "West Virginia", "WV"],
  ["US", "America/Chicago", "Alabama", "AL", "Arkansas", "AR", "Illinois", "IL", "Iowa", "IA", "Kansas", "KS", "Louisiana", "LA",
    "Minnesota", "MN", "Mississippi", "MS", "Missouri", "MO", "Nebraska", "NE", "North Dakota", "ND", "Oklahoma", "OK",
    "South Dakota", "SD", "Tennessee", "TN", "Texas", "TX", "Wisconsin", "WI"],
  ["US", "America/Denver", "Colorado", "CO", "Montana", "MT", "New Mexico", "NM", "Utah", "UT", "Wyoming", "WY", "Idaho", "ID"],
  ["US", "America/Phoenix", "Arizona", "AZ"],
  ["US", "America/Los_Angeles", "California", "CA", "Nevada", "NV", "Oregon", "OR", "Washington", "WA"],
  ["US", "America/Anchorage", "Alaska", "AK"],
  ["US", "Pacific/Honolulu", "Hawaii", "HI"],
  ["CA", "America/Toronto", "Ontario", "ON", "Quebec", "Québec", "QC"],
  ["CA", "America/Vancouver", "British Columbia", "BC"],
  ["CA", "America/Edmonton", "Alberta", "AB"],
  ["CA", "America/Winnipeg", "Manitoba", "MB"],
  ["CA", "America/Regina", "Saskatchewan", "SK"],
  ["CA", "America/Halifax", "Nova Scotia", "NS", "Prince Edward Island", "PE"],
  ["CA", "America/Moncton", "New Brunswick", "NB"],
  ["CA", "America/St_Johns", "Newfoundland and Labrador", "Newfoundland", "NL"],
  ["AU", "Australia/Sydney", "New South Wales", "NSW", "Australian Capital Territory", "ACT"],
  ["AU", "Australia/Melbourne", "Victoria", "VIC"],
  ["AU", "Australia/Brisbane", "Queensland", "QLD"],
  ["AU", "Australia/Perth", "Western Australia", "WA"],
  ["AU", "Australia/Adelaide", "South Australia", "SA"],
  ["AU", "Australia/Hobart", "Tasmania", "TAS"],
  ["AU", "Australia/Darwin", "Northern Territory", "NT"],
];

/** Country-code domains used as generic names (startups, media), which name no country. */
const GENERIC_CCTLDS = new Set([
  "co", "io", "ai", "me", "am", "md", "cm", "tv", "fm", "ly", "gg", "to", "cc", "ws", "sh", "ac", "la", "so", "vc", "nu", "tk",
]);

function key(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/[.\s]+/g, " ").trim();
}

const BY_ISO2 = new Map(COUNTRIES.map((c) => [c.iso2, c]));
const BY_NAME = new Map<string, CountryRow>();
for (const c of COUNTRIES) {
  BY_NAME.set(key(c.iso2), c);
  for (const n of c.names) BY_NAME.set(key(n), c);
}
const BY_CALLING_CODE = new Map<string, CountryRow>();
for (const c of COUNTRIES) if (c.callingCode) BY_CALLING_CODE.set(c.callingCode, c);
const BY_CCTLD = new Map<string, CountryRow>();
for (const c of COUNTRIES) if (!GENERIC_CCTLDS.has(c.iso2.toLowerCase())) BY_CCTLD.set(c.iso2.toLowerCase(), c);
BY_CCTLD.set("uk", BY_ISO2.get("GB") as CountryRow);
const SUBDIVISION_ZONE = new Map<string, string>();
for (const [iso2, zone, ...names] of SUBDIVISION_DATA) for (const n of names) SUBDIVISION_ZONE.set(`${iso2}|${key(n)}`, zone);

/** Every zone the tables can answer: a test asserts each is a zone the runtime knows. */
export const ALL_TABLE_ZONES: string[] = [
  ...new Set([...COUNTRIES.map((c) => c.zone).filter((z): z is string => !!z), ...SUBDIVISION_DATA.map((r) => r[1])]),
];
/** Calling codes in the table: a test asserts none is a prefix of another. */
export const ALL_CALLING_CODES: string[] = [...BY_CALLING_CODE.keys()];

export function countryOfName(name: string | null | undefined): string | null {
  if (!name || !name.trim()) return null;
  return BY_NAME.get(key(name))?.iso2 ?? null;
}

/** The country an international number dials (`+44 7700 900123`, `0044…`). A national number names none. */
export function countryOfPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const compact = phone.replace(/[\s\-(). /]/g, "");
  let digits: string;
  if (compact.startsWith("+")) digits = compact.slice(1);
  else if (compact.startsWith("00")) digits = compact.slice(2);
  else return null;
  if (!/^\d{7,15}$/.test(digits)) return null;
  for (const len of [3, 2, 1]) {
    const row = BY_CALLING_CODE.get(digits.slice(0, len));
    if (row) return row.iso2;
  }
  return null;
}

/** The country an address's country-code domain names (`.co.uk` -> GB); generic ones name none. */
export function countryOfEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return BY_CCTLD.get(tld)?.iso2 ?? null;
}

/** The zone of a country, refined by its state / province when the country keeps several clocks. */
export function zoneOf(iso2: string, state?: string | null): string | null {
  const row = BY_ISO2.get(iso2);
  if (!row) return null;
  if (row.zone) return row.zone;
  if (!state || !state.trim()) return null;
  return SUBDIVISION_ZONE.get(`${iso2}|${key(state)}`) ?? null;
}

interface Signal {
  basis: TimezoneBasis;
  country: string;
  zone: string | null;
}

export function inferTimezone(signals: TimezoneSignals): InferredTimezone | null {
  const ordered: Signal[] = [];
  const leadCountry = countryOfName(signals.leadCountry);
  if (leadCountry) ordered.push({ basis: "lead_location", country: leadCountry, zone: zoneOf(leadCountry, signals.leadState) });
  for (const phone of signals.phones ?? []) {
    const c = countryOfPhone(phone);
    if (c) ordered.push({ basis: "phone_country", country: c, zone: zoneOf(c) });
  }
  const companyCountry = countryOfName(signals.companyCountry);
  if (companyCountry) {
    ordered.push({ basis: "company_location", country: companyCountry, zone: zoneOf(companyCountry, signals.companyState) });
  }
  for (const email of signals.emails ?? []) {
    const c = countryOfEmail(email);
    if (c) ordered.push({ basis: "email_domain", country: c, zone: zoneOf(c) });
  }
  if (ordered.length === 0) return null;
  const country = ordered[0].country;
  const hit = ordered.find((s) => s.country === country && s.zone);
  return hit ? { timezone: hit.zone as string, basis: hit.basis, country } : null;
}

/** A zone the runtime can schedule in (`Europe/London`), never an offset or a free string. */
export function isIanaTimezone(zone: string): boolean {
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(zone) && zone !== "UTC") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
