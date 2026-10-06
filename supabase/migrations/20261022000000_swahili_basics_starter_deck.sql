-- Additive content migration: a third official starter deck, "Swahili
-- Basics" (Swahili -> English), alongside the existing two TOEFL English
-- decks. Does NOT edit 20260923220000_official_starter_deck_data.sql
-- (already applied) in place -- that migration's own guard
-- ("if exists (select 1 from public.decks where is_official = true)
-- then raise exception") is specific to IT being the sole origin of the
-- first two official decks; reusing it verbatim here would immediately
-- raise, since those two already exist. This migration's own guard
-- below checks only for ITS OWN deck (by its deterministic id), the
-- correct equivalent for a THIRD official deck added later.
--
-- No Learning Engine, Repair/cooldown/SRS, source-weight, or legacy
-- behavior is touched by this migration -- it only inserts one row into
-- `decks` and 60 rows into `cards`, exactly mirroring the shape and
-- grants the existing two official decks already have.
--
-- Source data: data/starter-decks/swahili_alpha_60.csv. Validated before
-- this migration was generated: exactly 60 data rows, a `word,meaning`
-- header mapping to Swahili front / English back, no empty front/back
-- values, no duplicate front values, no malformed rows, same UTF-8-with-
-- BOM encoding as the existing two starter-deck CSVs. The CSV remains in
-- the repo as a source-of-truth artifact for reproducibility -- this
-- migration does not read it at runtime; all 60 (front, back, id)
-- triples are embedded below as literal values, same convention as
-- 20260923220000_official_starter_deck_data.sql.
--
-- Determinism: ids are UUIDv5 (RFC 4122), computed offline from the same
-- standard NAMESPACE_URL namespace (6ba7b811-9dad-11d1-80b4-00c04fd430c8)
-- this project's existing starter decks already use, with the identical
-- seed-string convention (see the generation note at the end of this
-- file) -- never gen_random_uuid() for these rows.
--
-- Idempotency/safety: the guard below raises a clear error if a deck
-- with this exact id already exists, so reapplying this migration fails
-- loudly instead of silently duplicating. The existing two official
-- decks and their cards are untouched -- this migration contains no
-- UPDATE/DELETE of any kind.
--
-- Availability: `lib/decks/dal.ts`'s getStarterDecks() already queries
-- generically (`is_template = true AND is_official = true AND
-- deleted_at IS NULL`, ordered by name) -- this deck appears
-- automatically in onboarding's starter-deck list for any NEW tester
-- from this point on, with no code change. It is never automatically
-- copied to an existing tester -- duplicate_starter_deck() is only ever
-- invoked by that one onboarding form action, on explicit user
-- selection (confirmed by inspection: its only callers are
-- app/actions/onboarding.ts and app/onboarding/deck/page.tsx).

do $$
begin
  if exists (select 1 from public.decks where id = 'baff1099-c438-5501-887b-6edf33882794') then
    raise exception 'swahili-basics starter-deck seed migration: deck baff1099-c438-5501-887b-6edf33882794 already exists -- refusing to insert a duplicate';
  end if;
end;
$$;

-- =========================================================================
-- Swahili Basics  (source: data/starter-decks/swahili_alpha_60.csv)
-- =========================================================================

insert into public.decks (
  id, name, description, front_language, back_language,
  owner_user_id, source_deck_id, is_template, is_official, visibility
) values (
  'baff1099-c438-5501-887b-6edf33882794',
  'Swahili Basics',
  '60 essential Swahili words for beginner learning.',
  'sw', 'en',
  null, null, true, true, 'public'
);

insert into public.cards (
  id, deck_id, front, back, extra_content,
  created_by_user_id, source_card_id, sort_order
) values
  ('790fc7e4-1093-5003-855c-1fe1ed12e3e8', 'baff1099-c438-5501-887b-6edf33882794', 'maji', 'water', '{}'::jsonb, null, null, 0),
  ('e52944ec-0335-5ce7-8270-284486558ccd', 'baff1099-c438-5501-887b-6edf33882794', 'chakula', 'food', '{}'::jsonb, null, null, 1),
  ('ae9fe519-cc2e-5503-93fc-84ab0c955d32', 'baff1099-c438-5501-887b-6edf33882794', 'mkate', 'bread', '{}'::jsonb, null, null, 2),
  ('8f4b424d-8959-5bd8-a221-0f1207821a36', 'baff1099-c438-5501-887b-6edf33882794', 'maziwa', 'milk', '{}'::jsonb, null, null, 3),
  ('562d9f9f-d661-58ac-9aef-045d29e7341a', 'baff1099-c438-5501-887b-6edf33882794', 'yai', 'egg', '{}'::jsonb, null, null, 4),
  ('429d7323-c9bc-52c9-95d2-745fb1bce185', 'baff1099-c438-5501-887b-6edf33882794', 'wali', 'rice', '{}'::jsonb, null, null, 5),
  ('3e664af4-be30-57a3-848a-faca9ee6a622', 'baff1099-c438-5501-887b-6edf33882794', 'chumvi', 'salt', '{}'::jsonb, null, null, 6),
  ('851be16b-b582-5331-ad9c-e8c4026302d9', 'baff1099-c438-5501-887b-6edf33882794', 'asali', 'honey', '{}'::jsonb, null, null, 7),
  ('871ee639-cd1e-5fab-9cb7-01c25c4dd7a7', 'baff1099-c438-5501-887b-6edf33882794', 'ndizi', 'banana', '{}'::jsonb, null, null, 8),
  ('02a141ea-3e0d-54eb-868a-1d3e79fe35e9', 'baff1099-c438-5501-887b-6edf33882794', 'nyama', 'meat', '{}'::jsonb, null, null, 9),
  ('2ed80cdb-42b9-5c36-9e8f-bda9b48cfdc0', 'baff1099-c438-5501-887b-6edf33882794', 'samaki', 'fish', '{}'::jsonb, null, null, 10),
  ('e002a768-ab39-5a81-bab7-f843be1a4328', 'baff1099-c438-5501-887b-6edf33882794', 'mboga', 'vegetable', '{}'::jsonb, null, null, 11),
  ('4a86941f-466f-5178-815e-b768c6c90909', 'baff1099-c438-5501-887b-6edf33882794', 'nyumba', 'house', '{}'::jsonb, null, null, 12),
  ('fb665237-52a0-5ad5-9e46-7f2a9e5ee78e', 'baff1099-c438-5501-887b-6edf33882794', 'chumba', 'room', '{}'::jsonb, null, null, 13),
  ('7aec0382-d3cb-52eb-a6bd-e7f56825bc8f', 'baff1099-c438-5501-887b-6edf33882794', 'mlango', 'door', '{}'::jsonb, null, null, 14),
  ('04b2cc37-b0b0-57f4-8603-df5652d5c189', 'baff1099-c438-5501-887b-6edf33882794', 'dirisha', 'window', '{}'::jsonb, null, null, 15),
  ('3671eb22-e937-5b6b-af72-6cba743f3e03', 'baff1099-c438-5501-887b-6edf33882794', 'kitanda', 'bed', '{}'::jsonb, null, null, 16),
  ('7b96601b-fe8d-5180-9365-f3e7f4d06c74', 'baff1099-c438-5501-887b-6edf33882794', 'meza', 'table', '{}'::jsonb, null, null, 17),
  ('27e1acca-7ff0-589c-8733-d8fb110c01cc', 'baff1099-c438-5501-887b-6edf33882794', 'kiti', 'chair', '{}'::jsonb, null, null, 18),
  ('5ffb127c-02e9-539c-b371-531e234169a4', 'baff1099-c438-5501-887b-6edf33882794', 'nguo', 'clothes', '{}'::jsonb, null, null, 19),
  ('ceaecf4b-3bde-55c0-bc7f-fd0c6eff6d06', 'baff1099-c438-5501-887b-6edf33882794', 'kiatu', 'shoe', '{}'::jsonb, null, null, 20),
  ('b68bff3e-1146-5654-b1f4-be5ff16af67f', 'baff1099-c438-5501-887b-6edf33882794', 'soko', 'market', '{}'::jsonb, null, null, 21),
  ('52d790ae-5c91-5d3f-89d7-f6bf90dc33d4', 'baff1099-c438-5501-887b-6edf33882794', 'duka', 'shop', '{}'::jsonb, null, null, 22),
  ('a8757778-afe8-563d-8fdc-2fe7100f3450', 'baff1099-c438-5501-887b-6edf33882794', 'barabara', 'road', '{}'::jsonb, null, null, 23),
  ('4cc9b4af-0c45-5503-a843-3f640ac92e3f', 'baff1099-c438-5501-887b-6edf33882794', 'daraja', 'bridge', '{}'::jsonb, null, null, 24),
  ('6f798c6f-bf5a-5390-893e-1a96efd675d9', 'baff1099-c438-5501-887b-6edf33882794', 'kijiji', 'village', '{}'::jsonb, null, null, 25),
  ('f6afd67e-bb22-502f-b6ce-d33432c83e29', 'baff1099-c438-5501-887b-6edf33882794', 'mto', 'river', '{}'::jsonb, null, null, 26),
  ('5c9e476b-5a24-5ff6-a4a6-9b5c758e666b', 'baff1099-c438-5501-887b-6edf33882794', 'mlima', 'mountain', '{}'::jsonb, null, null, 27),
  ('8f9f6b06-aebf-5aa6-be1a-b7b28ba79827', 'baff1099-c438-5501-887b-6edf33882794', 'ziwa', 'lake', '{}'::jsonb, null, null, 28),
  ('b8307ea4-c128-59e0-acd6-a3857f0465e5', 'baff1099-c438-5501-887b-6edf33882794', 'bahari', 'sea', '{}'::jsonb, null, null, 29),
  ('84ade571-efa4-5d03-b571-795b3e25ed85', 'baff1099-c438-5501-887b-6edf33882794', 'msitu', 'forest', '{}'::jsonb, null, null, 30),
  ('d961ea6f-3ceb-526d-a652-0977ff6237d0', 'baff1099-c438-5501-887b-6edf33882794', 'anga', 'sky', '{}'::jsonb, null, null, 31),
  ('0d10458b-a75b-5cee-b975-96c7f158e8df', 'baff1099-c438-5501-887b-6edf33882794', 'nyota', 'star', '{}'::jsonb, null, null, 32),
  ('af109d8d-36ff-55c7-9fa9-f0b6800d73d0', 'baff1099-c438-5501-887b-6edf33882794', 'mvua', 'rain', '{}'::jsonb, null, null, 33),
  ('a847a4a9-9d8f-5830-92ce-392708d414ab', 'baff1099-c438-5501-887b-6edf33882794', 'upepo', 'wind', '{}'::jsonb, null, null, 34),
  ('9afc3979-0de9-5369-955a-7a9e18651c8f', 'baff1099-c438-5501-887b-6edf33882794', 'wingu', 'cloud', '{}'::jsonb, null, null, 35),
  ('f6934b78-df85-5b77-8bc0-d8f1f3092d3f', 'baff1099-c438-5501-887b-6edf33882794', 'jiwe', 'stone', '{}'::jsonb, null, null, 36),
  ('70c94fac-51b2-564a-b2d7-dea235f5ef51', 'baff1099-c438-5501-887b-6edf33882794', 'mti', 'tree', '{}'::jsonb, null, null, 37),
  ('78e073be-9e3a-5f71-b394-a3439a00e422', 'baff1099-c438-5501-887b-6edf33882794', 'jani', 'leaf', '{}'::jsonb, null, null, 38),
  ('a8f5955f-9905-53cb-92fd-ee62de0d3090', 'baff1099-c438-5501-887b-6edf33882794', 'kuku', 'chicken', '{}'::jsonb, null, null, 39),
  ('550105df-9223-5925-afee-28d77045eb1a', 'baff1099-c438-5501-887b-6edf33882794', 'mbwa', 'dog', '{}'::jsonb, null, null, 40),
  ('3863a214-2e2f-5eb2-a0e8-c0345d0f95e5', 'baff1099-c438-5501-887b-6edf33882794', 'paka', 'cat', '{}'::jsonb, null, null, 41),
  ('4f938418-718a-5627-8c10-98770819bb98', 'baff1099-c438-5501-887b-6edf33882794', 'ng''ombe', 'cow', '{}'::jsonb, null, null, 42),
  ('8438bddd-8b7e-5322-888b-7fee8869fa5f', 'baff1099-c438-5501-887b-6edf33882794', 'farasi', 'horse', '{}'::jsonb, null, null, 43),
  ('fe30dcaf-d635-55d6-a77d-e091c7a574cf', 'baff1099-c438-5501-887b-6edf33882794', 'sungura', 'rabbit', '{}'::jsonb, null, null, 44),
  ('abec765a-8655-5a30-8b7d-b0392f6fe611', 'baff1099-c438-5501-887b-6edf33882794', 'kula', 'eat', '{}'::jsonb, null, null, 45),
  ('5365958d-5ebb-543e-b048-569a490d8bea', 'baff1099-c438-5501-887b-6edf33882794', 'kunywa', 'drink', '{}'::jsonb, null, null, 46),
  ('a38129c0-0879-5422-84bd-5a01b07d8dd7', 'baff1099-c438-5501-887b-6edf33882794', 'kwenda', 'go', '{}'::jsonb, null, null, 47),
  ('23af0563-de8b-5ed8-8965-26f01a6141c5', 'baff1099-c438-5501-887b-6edf33882794', 'kuja', 'come', '{}'::jsonb, null, null, 48),
  ('3946f337-d053-5950-b71e-a250bb10ab4d', 'baff1099-c438-5501-887b-6edf33882794', 'kuona', 'see', '{}'::jsonb, null, null, 49),
  ('222cb856-5d5e-5157-b07b-2082b41a87e9', 'baff1099-c438-5501-887b-6edf33882794', 'kuandika', 'write', '{}'::jsonb, null, null, 50),
  ('1272f2fb-fe5b-5d9b-a868-5212d6f75485', 'baff1099-c438-5501-887b-6edf33882794', 'kulala', 'sleep', '{}'::jsonb, null, null, 51),
  ('2de20078-ef10-5f38-8b01-d8b653b9f959', 'baff1099-c438-5501-887b-6edf33882794', 'kuamka', 'wake up', '{}'::jsonb, null, null, 52),
  ('c50046b5-9522-57f9-81d3-ac1c75ea4546', 'baff1099-c438-5501-887b-6edf33882794', 'kusimama', 'stand', '{}'::jsonb, null, null, 53),
  ('983815fd-138b-561b-9766-b82bfda20e51', 'baff1099-c438-5501-887b-6edf33882794', 'kukimbia', 'run', '{}'::jsonb, null, null, 54),
  ('eccb2373-4f5f-5f0c-9756-0f46614bc80f', 'baff1099-c438-5501-887b-6edf33882794', 'kutembea', 'walk', '{}'::jsonb, null, null, 55),
  ('6a8c05da-3ffd-5b11-98bc-0daa84c4fa65', 'baff1099-c438-5501-887b-6edf33882794', 'kuogelea', 'swim', '{}'::jsonb, null, null, 56),
  ('20f8cab0-a735-5be3-804e-781f203d32be', 'baff1099-c438-5501-887b-6edf33882794', 'kupika', 'cook', '{}'::jsonb, null, null, 57),
  ('51ee7612-c7ee-52b8-af7b-f3509eed144f', 'baff1099-c438-5501-887b-6edf33882794', 'kununua', 'buy', '{}'::jsonb, null, null, 58),
  ('6a3315e4-c80f-57a1-8069-dacd2ec6b867', 'baff1099-c438-5501-887b-6edf33882794', 'kuuza', 'sell', '{}'::jsonb, null, null, 59);

-- =========================================================================
-- Generation note (for reproducibility)
-- =========================================================================
--
-- NAMESPACE_URL (RFC 4122 standard namespace for URLs, same constant the
-- existing starter decks use):
--   6ba7b811-9dad-11d1-80b4-00c04fd430c8
--
-- Deck id = uuid5(NAMESPACE_URL, 'https://vocabbattle.app/starter-decks/<slug>')
--   Swahili Basics (slug: swahili-basics) = baff1099-c438-5501-887b-6edf33882794
--
-- Card id = uuid5(NAMESPACE_URL, 'https://vocabbattle.app/starter-decks/<slug>/cards/<sort_order zero-padded to 3 digits>/<front>')
-- where <slug> is swahili-basics and <front> is the exact CSV front value
-- for that row (e.g. row 0: .../cards/000/maji).
