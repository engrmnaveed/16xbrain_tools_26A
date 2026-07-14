/**
 * Component C — Standalone Mock Dictionary Matrix.
 *
 * Design goal: faker.js-class realism with a ~10 KB footprint instead of a
 * multi-MB node_modules dependency at runtime, fully offline.
 *
 * The trick is COMPOSITION, not enumeration. We don't ship 250,000 names —
 * we ship small orthogonal word lists and let the seeded PRNG combine them:
 *
 *   100 first × 100 last                    = 10,000 distinct full names
 *   ... × 12 domains × index suffix         = globally unique emails, unbounded
 *   40 street names × 6 suffixes × #### num = ~2.4M distinct addresses
 *
 * Scaling path for the commercial build: promote these arrays to JSON assets
 * (e.g. /assets/dicts/en.json, de.json, ...) bundled by Vite and loaded once
 * at startup — still offline, still deterministic, just bigger matrices and
 * localizable. The generator code never changes; only the arrays grow.
 *
 * IMPORTANT: entries are append-only in the commercial build. Reordering or
 * removing entries changes index→value mapping and breaks seed reproducibility
 * across app versions. Version the dictionary set (DICT_VERSION) and store it
 * in project files so old projects can regenerate identical data.
 */

export const DICT_VERSION = 1;

export const FIRST_NAMES: readonly string[] = [
  'James', 'Mary', 'Robert', 'Patricia', 'John', 'Jennifer', 'Michael', 'Linda',
  'David', 'Elizabeth', 'William', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica',
  'Thomas', 'Sarah', 'Charles', 'Karen', 'Christopher', 'Lisa', 'Daniel', 'Nancy',
  'Matthew', 'Betty', 'Anthony', 'Sandra', 'Mark', 'Margaret', 'Donald', 'Ashley',
  'Steven', 'Kimberly', 'Andrew', 'Emily', 'Paul', 'Donna', 'Joshua', 'Michelle',
  'Kenneth', 'Carol', 'Kevin', 'Amanda', 'Brian', 'Melissa', 'George', 'Deborah',
  'Timothy', 'Stephanie', 'Ronald', 'Rebecca', 'Jason', 'Laura', 'Edward', 'Sharon',
  'Jeffrey', 'Cynthia', 'Ryan', 'Kathleen', 'Jacob', 'Amy', 'Gary', 'Angela',
  'Nicholas', 'Shirley', 'Eric', 'Anna', 'Jonathan', 'Ruth', 'Stephen', 'Brenda',
  'Larry', 'Pamela', 'Justin', 'Nicole', 'Scott', 'Katherine', 'Brandon', 'Samantha',
  'Benjamin', 'Christine', 'Samuel', 'Emma', 'Gregory', 'Catherine', 'Alexander', 'Debra',
  'Patrick', 'Virginia', 'Frank', 'Rachel', 'Raymond', 'Carolyn', 'Jack', 'Janet',
  'Dennis', 'Maria', 'Jerry', 'Heather', 'Tyler', 'Diane', 'Aaron', 'Julie',
  'Omar', 'Fatima', 'Wei', 'Mei', 'Hiroshi', 'Yuki', 'Ahmed', 'Aisha',
  'Carlos', 'Sofia', 'Luca', 'Chiara', 'Ivan', 'Olga', 'Lars', 'Ingrid',
  'Priya', 'Arjun', 'Amara', 'Kwame', 'Naveed', 'Zara', 'Mateo', 'Camila',
];

export const LAST_NAMES: readonly string[] = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas',
  'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson', 'White',
  'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young',
  'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
  'Green', 'Adams', 'Nelson', 'Baker', 'Hall', 'Rivera', 'Campbell', 'Mitchell',
  'Carter', 'Roberts', 'Gomez', 'Phillips', 'Evans', 'Turner', 'Diaz', 'Parker',
  'Cruz', 'Edwards', 'Collins', 'Reyes', 'Stewart', 'Morris', 'Morales', 'Murphy',
  'Cook', 'Rogers', 'Gutierrez', 'Ortiz', 'Morgan', 'Cooper', 'Peterson', 'Bailey',
  'Reed', 'Kelly', 'Howard', 'Ramos', 'Kim', 'Cox', 'Ward', 'Richardson',
  'Watson', 'Brooks', 'Chavez', 'Wood', 'James', 'Bennett', 'Gray', 'Mendoza',
  'Hussain', 'Khan', 'Chen', 'Wang', 'Tanaka', 'Sato', 'Silva', 'Santos',
  'Rossi', 'Ferrari', 'Ivanov', 'Petrov', 'Larsen', 'Berg', 'Patel', 'Sharma',
  'Okafor', 'Mensah', 'Yilmaz', 'Kaya', 'Novak', 'Kowalski', 'Andersson', 'Nilsson',
];

export const EMAIL_DOMAINS: readonly string[] = [
  'example.com', 'mail.test', 'inbox.dev', 'corpmail.test', 'fastpost.dev',
  'workmail.test', 'mailbox.example', 'letterbox.dev', 'postbox.test',
  'mymail.example', 'zenmail.dev', 'nordmail.test',
];

export const STREET_NAMES: readonly string[] = [
  'Maple', 'Oak', 'Cedar', 'Pine', 'Elm', 'Willow', 'Birch', 'Aspen',
  'Main', 'Park', 'Lake', 'Hill', 'River', 'Sunset', 'Highland', 'Meadow',
  'Washington', 'Franklin', 'Jefferson', 'Lincoln', 'Madison', 'Monroe',
  'Chestnut', 'Walnut', 'Spruce', 'Juniper', 'Magnolia', 'Sycamore',
  'Harbor', 'Bridge', 'Canyon', 'Prairie', 'Summit', 'Valley', 'Garden', 'Spring',
  'Church', 'Market', 'Union', 'Liberty',
];

export const STREET_SUFFIXES: readonly string[] = [
  'St', 'Ave', 'Blvd', 'Dr', 'Ln', 'Way', 'Ct', 'Pl',
];

export const CITIES: readonly string[] = [
  'Springfield', 'Riverton', 'Fairview', 'Kingsport', 'Lakewood', 'Brookhaven',
  'Cedarville', 'Milton', 'Ashford', 'Georgetown', 'Salem', 'Clayton',
  'Bristol', 'Oxford', 'Dover', 'Hudson', 'Camden', 'Dayton',
  'Aurora', 'Franklin', 'Greenville', 'Bristol Bay', 'Clinton', 'Madison',
  'Arlington', 'Burlington', 'Manchester', 'Newport', 'Winchester', 'Lexington',
  'Harborview', 'Stonebridge', 'Westfield', 'Eastvale', 'Northgate', 'Southport',
  'Glenwood', 'Ridgecrest', 'Silverton', 'Goldfield',
];

export const COUNTRIES: readonly string[] = [
  'United States', 'Canada', 'United Kingdom', 'Germany', 'France', 'Spain',
  'Italy', 'Netherlands', 'Sweden', 'Norway', 'Poland', 'Portugal',
  'Japan', 'South Korea', 'Australia', 'New Zealand', 'Brazil', 'Mexico',
  'India', 'Pakistan', 'Turkey', 'Egypt', 'Nigeria', 'South Africa', 'Argentina',
];

export const COMPANY_HEADS: readonly string[] = [
  'Apex', 'Nimbus', 'Vertex', 'Quantum', 'Stellar', 'Cobalt', 'Ember', 'Drift',
  'Forge', 'Beacon', 'Cascade', 'Summit', 'Orbit', 'Pulse', 'Vector', 'Zephyr',
  'Granite', 'Harbor', 'Iron', 'Juniper', 'Krypton', 'Lumen', 'Meridian', 'Nova',
];

export const COMPANY_TAILS: readonly string[] = [
  'Labs', 'Systems', 'Dynamics', 'Industries', 'Solutions', 'Works', 'Group',
  'Holdings', 'Logistics', 'Analytics', 'Technologies', 'Partners', 'Co', 'Corp',
];

export const WORDS: readonly string[] = [
  'amber', 'anchor', 'arrow', 'atlas', 'aurora', 'basin', 'beacon', 'birch',
  'blossom', 'breeze', 'canyon', 'cinder', 'cipher', 'cliff', 'cloud', 'comet',
  'coral', 'crane', 'crystal', 'current', 'dawn', 'delta', 'drift', 'dune',
  'echo', 'ember', 'fable', 'falcon', 'fern', 'flint', 'forge', 'frost',
  'garnet', 'glacier', 'grove', 'harbor', 'hazel', 'horizon', 'ivory', 'jade',
  'juniper', 'kestrel', 'lagoon', 'lantern', 'ledge', 'lotus', 'lumen', 'marble',
  'meadow', 'mesa', 'mirror', 'moss', 'nectar', 'north', 'oasis', 'onyx',
  'opal', 'orbit', 'osprey', 'pebble', 'pine', 'plume', 'prism', 'quarry',
  'quartz', 'raven', 'reef', 'ridge', 'ripple', 'river', 'saffron', 'sage',
  'shard', 'shore', 'sierra', 'slate', 'solstice', 'sparrow', 'spire', 'spruce',
  'summit', 'tempest', 'thistle', 'tide', 'timber', 'topaz', 'trail', 'tundra',
  'umber', 'vale', 'vapor', 'vertex', 'violet', 'vista', 'wander', 'willow',
  'winter', 'wren', 'zenith', 'zephyr',
];

/** Slots available inside 'template' columns, e.g. '{firstName}.{lastName}@{domain}'. */
export const TEMPLATE_SLOTS: Record<string, readonly string[]> = {
  firstName: FIRST_NAMES,
  lastName: LAST_NAMES,
  domain: EMAIL_DOMAINS,
  street: STREET_NAMES,
  streetSuffix: STREET_SUFFIXES,
  city: CITIES,
  country: COUNTRIES,
  companyHead: COMPANY_HEADS,
  companyTail: COMPANY_TAILS,
  word: WORDS,
};
