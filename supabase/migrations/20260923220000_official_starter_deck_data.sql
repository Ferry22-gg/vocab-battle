-- Official starter-deck template data (Advanced English Vocabulary I / II).
-- Source of truth: docs/MVP_SPEC_FOR_CLAUDE.md section 6, docs/DATABASE_SCHEMA.md
-- section 5 ("5. Starter deck duplication model") and section 4.2's official
-- starter deck example.
--
-- Scope for this migration only: the two official (is_template = true,
-- is_official = true) decks and their 200 cards (100 each). No
-- user_card_progress rows are created here -- those are created only by
-- duplicate_starter_deck() (see 20260923190000_duplicate_and_session_functions.sql)
-- when a tester duplicates one of these templates.
--
-- Source data: data/starter-decks/toefl_100_deck.csv (-> "Advanced English
-- Vocabulary I", the lower/base approximate TOEFL level per
-- MVP_SPEC_FOR_CLAUDE.md section 6) and data/starter-decks/toefl_110_120_deck.csv
-- (-> "Advanced English Vocabulary II", the higher approximate TOEFL level).
-- Both were validated before this migration was generated: exactly 100 data
-- rows each, a `word,meaning` header mapping to English front / Japanese back,
-- no empty front/back values, no duplicate front values within either file,
-- no malformed rows. The two CSVs remain in the repo as source-of-truth
-- artifacts for reproducibility -- this migration does not read them at
-- runtime; all 200 (front, back, id) triples are embedded below as literal
-- values.
--
-- Determinism: every id below is a UUIDv5 (RFC 4122), computed once offline
-- from the standard NAMESPACE_URL namespace (6ba7b811-9dad-11d1-80b4-00c04fd430c8)
-- and a stable, readable seed string per row (see the generation note at the
-- end of this file). UUIDv5 is a pure hash function of its inputs, so
-- re-running the same generation approach against the same CSVs reproduces
-- the exact same ids -- this migration never calls gen_random_uuid() for these
-- rows, and the ids are identical across every environment it is applied to.
--
-- Idempotency/safety: this migration intentionally does NOT use
-- `ON CONFLICT DO NOTHING`/`DO UPDATE`. The guard below raises a clear error
-- if any is_official deck already exists (this migration is expected to be
-- the sole origin of official template decks), and every INSERT below is a
-- plain INSERT, so a primary-key or unique-constraint conflict -- e.g. this
-- migration being reapplied against a database that already has this data --
-- fails loudly instead of silently creating a duplicate or silently doing
-- nothing.

do $$
begin
  if exists (select 1 from public.decks where is_official = true) then
    raise exception 'official starter-deck seed migration: an is_official deck already exists -- refusing to insert duplicate official templates';
  end if;
end;
$$;

-- =========================================================================
-- Advanced English Vocabulary I  (source: data/starter-decks/toefl_100_deck.csv)
-- =========================================================================

insert into public.decks (
  id, name, description, front_language, back_language,
  owner_user_id, source_deck_id, is_template, is_official, visibility
) values (
  'ff53281a-0e3d-5d2a-9356-29cf9589ef40',
  'Advanced English Vocabulary I',
  'Official starter deck. Advanced English vocabulary at an approximate TOEFL 100 level.',
  'en', 'ja',
  null, null, true, true, 'public'
);

insert into public.cards (
  id, deck_id, front, back, extra_content,
  created_by_user_id, source_card_id, sort_order
) values
  ('f051eec3-6dbd-5d08-8f1a-646f3508023a', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'abate', '弱まる、和らぐ', '{}'::jsonb, null, null, 0),
  ('affd76b9-5687-5aa1-ae22-07602044b4d5', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'aberration', '異常、逸脱', '{}'::jsonb, null, null, 1),
  ('791be594-1be0-5ff9-a555-0b58d706ba11', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'abstruse', '難解な', '{}'::jsonb, null, null, 2),
  ('869a1f04-db7e-5b0f-a9ea-678100abba30', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'acclimate', '環境に順応する', '{}'::jsonb, null, null, 3),
  ('024d723a-dee6-5396-b7bd-05535da065b8', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'acquiesce', 'しぶしぶ同意する', '{}'::jsonb, null, null, 4),
  ('510377c1-6721-5169-918a-53bb1e973714', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'acute', '深刻な、鋭い', '{}'::jsonb, null, null, 5),
  ('82cc3ad2-6fe7-5f69-be1c-22b5a661c6df', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'affinity', '類似性、親和性', '{}'::jsonb, null, null, 6),
  ('39e564f7-95f7-5746-bb24-6bb6be991861', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'aggregate', '集合する、総計', '{}'::jsonb, null, null, 7),
  ('f6e0eceb-3395-5339-a01f-2a0d5d47b9cf', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'ancillary', '補助的な', '{}'::jsonb, null, null, 8),
  ('f36bf7cc-799c-5355-9bdd-6954f5145c19', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'anomalous', '異常な、例外的な', '{}'::jsonb, null, null, 9),
  ('e56f66ed-20b5-5930-8cd2-d81d8da9afc5', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'antecedent', '先行するもの、前例', '{}'::jsonb, null, null, 10),
  ('f0bd8e9f-27f3-5f0d-a20f-64c62d7d22db', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'appease', 'なだめる、鎮める', '{}'::jsonb, null, null, 11),
  ('0396b04a-ac48-5b15-b639-478fa9a6ed1f', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'archetypal', '典型的な、原型的な', '{}'::jsonb, null, null, 12),
  ('a312d616-2573-5113-9204-9e1e407b1e3a', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'attenuate', '弱める、減衰させる', '{}'::jsonb, null, null, 13),
  ('a1b9abd9-195f-5afd-8e3f-ffd8d056ff6a', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'augment', '増大させる', '{}'::jsonb, null, null, 14),
  ('8e009d5a-a5bd-5573-88ec-902802e7511f', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'austere', '厳しい、質素な', '{}'::jsonb, null, null, 15),
  ('20e5918a-37a4-53f8-b209-1b86ba1b64c6', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'avert', '回避する、防ぐ', '{}'::jsonb, null, null, 16),
  ('82313d06-43a6-511d-b86b-6845ef3ef459', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'burgeon', '急速に成長する', '{}'::jsonb, null, null, 17),
  ('bb7ee822-b3b3-5688-b453-65433be9c41c', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'circumvent', '回避する', '{}'::jsonb, null, null, 18),
  ('727ec065-a914-5abb-82ee-51887da46122', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'coalesce', '合体する、融合する', '{}'::jsonb, null, null, 19),
  ('e556db3d-39d6-5d7a-aeeb-3c67d65040ae', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'concomitant', '付随する、伴う', '{}'::jsonb, null, null, 20),
  ('5967bb80-b428-57e1-8982-35312dbc0ff7', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'conjecture', '推測、推測する', '{}'::jsonb, null, null, 21),
  ('c8c7e006-7cdb-536e-a418-18aab254ec7e', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'conspicuous', '目立つ、明白な', '{}'::jsonb, null, null, 22),
  ('f04c13d4-1821-5e24-99db-cfbf59dfa8cc', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'construe', '解釈する', '{}'::jsonb, null, null, 23),
  ('d6cca504-07f5-5c73-9968-2aebb5d912b0', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'contentious', '議論を呼ぶ', '{}'::jsonb, null, null, 24),
  ('63ae0fe3-8fe8-5612-8d8d-c9d13c99282e', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'counteract', '打ち消す', '{}'::jsonb, null, null, 25),
  ('843d0086-825e-5ec1-a8cc-c7a2c730d5ce', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'culminate', '最高潮に達する', '{}'::jsonb, null, null, 26),
  ('3d9df6b0-896e-5607-a73a-623fc7689b0a', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'delineate', '明確に示す、描写する', '{}'::jsonb, null, null, 27),
  ('f67271a0-4184-5563-99aa-d5031bbe5c2a', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'detrimental', '有害な', '{}'::jsonb, null, null, 28),
  ('4f65fbd4-f3f0-5310-a3ff-f8a94f75ac20', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'diffusion', '拡散、普及', '{}'::jsonb, null, null, 29),
  ('3fd7fcfd-2f9a-5890-a39f-4c0e90b7ca4b', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'displace', '取って代わる、移動させる', '{}'::jsonb, null, null, 30),
  ('536c0a03-0e95-54b3-92fa-c920f503fa4b', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'divergent', '異なる方向に進む', '{}'::jsonb, null, null, 31),
  ('0dad595c-7666-5c73-85a4-4cefb46332df', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'elusive', '捉えにくい、理解しにくい', '{}'::jsonb, null, null, 32),
  ('dbeb603a-96d1-575e-ab9d-dc931adc4161', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'embryonic', '初期段階の', '{}'::jsonb, null, null, 33),
  ('2fccc0b0-404b-520d-b23b-354bd6da83d1', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'endemic', 'ある地域特有の', '{}'::jsonb, null, null, 34),
  ('82383670-7e51-52ba-98bd-f1b148b6bf88', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'engender', '生じさせる', '{}'::jsonb, null, null, 35),
  ('052ab64f-9936-56b0-84f8-bd8ce7552aec', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'ephemeral', '一時的な、短命な', '{}'::jsonb, null, null, 36),
  ('79d75abc-4109-5cb5-b948-133c08f65544', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'equilibrium', '均衡', '{}'::jsonb, null, null, 37),
  ('c575442b-bdb9-5426-bb90-6fcbe6222054', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'equivocal', '曖昧な', '{}'::jsonb, null, null, 38),
  ('e4da93ec-b4f5-5fcc-a237-513a355d1f73', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'erode', '徐々に侵食する、弱める', '{}'::jsonb, null, null, 39),
  ('9caa8c59-856f-5cdc-8837-cc70db15f30f', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'extant', '現存する', '{}'::jsonb, null, null, 40),
  ('bb0347ba-e3da-56a1-a17e-0645612d0919', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'extrapolate', '既知の情報から推定する', '{}'::jsonb, null, null, 41),
  ('aa4aba2d-4f82-55bd-91d1-15379b8d2672', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'finite', '有限の', '{}'::jsonb, null, null, 42),
  ('dc1a11a3-3818-59e9-ba52-52ca0729fcaa', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'galvanize', '刺激して行動させる', '{}'::jsonb, null, null, 43),
  ('e4938138-584f-5c94-8223-4ae952485a4e', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'germane', '密接に関連した', '{}'::jsonb, null, null, 44),
  ('7fdeaf85-ca73-57a1-81f0-826a76b2ec64', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'heterogeneous', '異質な、多様な', '{}'::jsonb, null, null, 45),
  ('ef4ae615-5f37-512c-a4d6-31febcb72e0b', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'hierarchical', '階層的な', '{}'::jsonb, null, null, 46),
  ('52221892-fc89-5a4e-8d51-3fc247a2edc5', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'impede', '妨げる', '{}'::jsonb, null, null, 47),
  ('c648faf6-5f31-5400-bc39-bdf373490e9f', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'incongruous', '不調和な、不一致な', '{}'::jsonb, null, null, 48),
  ('9b123144-5f4d-5d87-9cb2-518e1fc65b3d', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'indigenous', '土着の、先住の', '{}'::jsonb, null, null, 49),
  ('e7fc26cf-5d2c-51c2-a13c-18bd34ef9b90', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'inexorable', '避けられない、止められない', '{}'::jsonb, null, null, 50),
  ('7a4bd529-644e-53bf-97d1-00c7c13b722c', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'inferential', '推論に基づく', '{}'::jsonb, null, null, 51),
  ('9d2d456a-f48a-59ae-bee6-35e089754931', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'insular', '孤立した、閉鎖的な', '{}'::jsonb, null, null, 52),
  ('9ef26c01-e57f-5942-868c-bc08ebaf79f3', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'latent', '潜在的な', '{}'::jsonb, null, null, 53),
  ('aaba493d-fe1c-51c5-9d83-e09520ad415e', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'malleable', '柔軟に変形できる', '{}'::jsonb, null, null, 54),
  ('430b6df2-93a7-5b6c-bd32-d4527ba13e31', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'manifest', '明らかな、明示する', '{}'::jsonb, null, null, 55),
  ('cf57fb0d-4889-5ede-8925-b60cb5ccd075', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'meticulous', '非常に細かい、綿密な', '{}'::jsonb, null, null, 56),
  ('96191d96-1c65-5403-9928-f8fb0733dfc7', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'myriad', '無数の', '{}'::jsonb, null, null, 57),
  ('56e692e5-d792-5ea9-8bc0-1fac9667c13e', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'nascent', '発生し始めた、初期の', '{}'::jsonb, null, null, 58),
  ('7c94fcc7-da06-5e4c-bde2-6dd5019f3554', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'obsolete', '時代遅れの', '{}'::jsonb, null, null, 59),
  ('af5b52d7-4cd9-5fd2-8fc0-0912aad2ec58', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'ostensibly', '表面上は', '{}'::jsonb, null, null, 60),
  ('0d1bb798-ab54-5bbe-9ef7-2376ee8c3f81', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'pervasive', '広く浸透した', '{}'::jsonb, null, null, 61),
  ('be570ad8-e606-5d87-99c9-21a42b877942', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'precipitate', '引き起こす、急激な', '{}'::jsonb, null, null, 62),
  ('aef33f09-9d9d-5c24-85c2-cfe27133c54e', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'preclude', '不可能にする、妨げる', '{}'::jsonb, null, null, 63),
  ('2ff729f1-c719-5d73-b489-9a174476ebd6', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'presuppose', '前提とする', '{}'::jsonb, null, null, 64),
  ('d0a28a20-1d30-59e4-9222-3e1b18bf2317', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'proliferate', '急増する、増殖する', '{}'::jsonb, null, null, 65),
  ('ad01295b-4054-57fc-a5bd-cde64f2cd7f4', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'propensity', '傾向、性向', '{}'::jsonb, null, null, 66),
  ('928d0358-6b4a-5091-bfdf-88e7fa52e9e5', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'reconcile', '調和させる', '{}'::jsonb, null, null, 67),
  ('55f60bb0-ed33-5d0a-b353-f579d5763889', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'recourse', '頼ること、手段', '{}'::jsonb, null, null, 68),
  ('f76df425-1e29-5f7b-85ae-22ba6d11df7d', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'redundant', '不要な、余分な', '{}'::jsonb, null, null, 69),
  ('fbf6a5c5-362e-5733-ac42-cf9305975a12', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'refute', '反証する', '{}'::jsonb, null, null, 70),
  ('3339e695-d984-51d9-b3b6-767100067130', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'relinquish', '放棄する', '{}'::jsonb, null, null, 71),
  ('0cf1ba83-3364-5f0b-8886-31730a3764a6', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'salient', '顕著な、重要な', '{}'::jsonb, null, null, 72),
  ('c4714b5e-1c11-5091-9967-376d08f49e36', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'scarcity', '不足、希少性', '{}'::jsonb, null, null, 73),
  ('3f8ab6c4-4592-5a3b-b9eb-d20280308361', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'sporadic', '散発的な', '{}'::jsonb, null, null, 74),
  ('981da677-f943-5d75-86cb-fa689137f255', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'stagnant', '停滞した', '{}'::jsonb, null, null, 75),
  ('3f51791f-13de-542b-8935-61ded1f46ece', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'stringent', '厳格な', '{}'::jsonb, null, null, 76),
  ('56d05984-749b-5813-ae65-8f0b9453534c', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'substantiate', '証拠で裏付ける', '{}'::jsonb, null, null, 77),
  ('30624002-f5a5-5582-99f9-3a0e144051c4', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'subsume', '包含する', '{}'::jsonb, null, null, 78),
  ('b1db6143-6c7d-501c-b2fd-f0c5e967acfd', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'supersede', '取って代わる', '{}'::jsonb, null, null, 79),
  ('a239df8e-2f97-5ae9-b1e4-c51b07fdfb40', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'tacit', '暗黙の', '{}'::jsonb, null, null, 80),
  ('f6b20a18-c729-52d2-b8e3-46713694559f', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'tenuous', '根拠の薄い、弱い', '{}'::jsonb, null, null, 81),
  ('e54a6557-415f-5425-b0ed-a1030ffb82f1', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'trajectory', '軌道、推移', '{}'::jsonb, null, null, 82),
  ('24e49073-d61f-5f2c-a6af-20d9f1954859', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'transient', '一時的な', '{}'::jsonb, null, null, 83),
  ('45ca5ea5-c55c-59ae-a99a-4abc7f599540', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'ubiquitous', '至る所に存在する', '{}'::jsonb, null, null, 84),
  ('302fc87d-2540-5770-afa8-b49917b92ca7', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'unequivocal', '明白な', '{}'::jsonb, null, null, 85),
  ('ac7dfa6e-658a-5a9e-bca7-3c9a525a2faf', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'unprecedented', '前例のない', '{}'::jsonb, null, null, 86),
  ('da657c5a-c1ff-5020-8416-aadfb3960d8b', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'untenable', '維持できない、支持できない', '{}'::jsonb, null, null, 87),
  ('f4f9ee41-e944-57cb-9526-2cbe71bd5eb3', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'vestige', '痕跡、名残', '{}'::jsonb, null, null, 88),
  ('3edc1724-51cf-5a2f-8777-02de145b95ab', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'viable', '実行可能な', '{}'::jsonb, null, null, 89),
  ('ed4fe5c7-e143-5d9a-afcf-a71a0fdd5804', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'volatile', '不安定な', '{}'::jsonb, null, null, 90),
  ('7ab3619c-c9e8-544b-a7de-b26fb8d836a3', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'warrant', '正当化する、根拠', '{}'::jsonb, null, null, 91),
  ('e79acc5c-d313-5715-8038-088dc898506d', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'withstand', '耐える', '{}'::jsonb, null, null, 92),
  ('fcd6a5ba-c630-5751-a70e-b438baa3582c', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'exacerbate', '悪化させる', '{}'::jsonb, null, null, 93),
  ('5c5f777e-9090-5ae0-989a-11a3f2c03eb0', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'mitigate', '緩和する', '{}'::jsonb, null, null, 94),
  ('bdb86c78-7d6c-5d91-9e77-1e6299e848fb', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'scrutinize', '綿密に調べる', '{}'::jsonb, null, null, 95),
  ('5a981d9c-89cc-5d8c-97c4-3b99a66891bc', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'corroborate', '裏付ける', '{}'::jsonb, null, null, 96),
  ('b36f2b94-17f7-53b7-9332-39840fa01216', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'discern', '見分ける、理解する', '{}'::jsonb, null, null, 97),
  ('8a7a01f6-073a-514d-9517-fff6e6ef9cc2', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'elucidate', '明らかにする、説明する', '{}'::jsonb, null, null, 98),
  ('fe509eab-c55e-5803-a4d2-7ea899e256ac', 'ff53281a-0e3d-5d2a-9356-29cf9589ef40', 'juxtapose', '並置して比較する', '{}'::jsonb, null, null, 99);

-- =========================================================================
-- Advanced English Vocabulary II  (source: data/starter-decks/toefl_110_120_deck.csv)
-- =========================================================================

insert into public.decks (
  id, name, description, front_language, back_language,
  owner_user_id, source_deck_id, is_template, is_official, visibility
) values (
  '68c17860-bcbd-5de3-92ed-47be695bf35a',
  'Advanced English Vocabulary II',
  'Official starter deck. Advanced English vocabulary at a higher approximate TOEFL 110-120 level.',
  'en', 'ja',
  null, null, true, true, 'public'
);

insert into public.cards (
  id, deck_id, front, back, extra_content,
  created_by_user_id, source_card_id, sort_order
) values
  ('36f1ef57-52e6-5294-8ba4-f4b7a8d81139', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'abrogate', '廃止する、撤廃する', '{}'::jsonb, null, null, 0),
  ('bfc4b0c6-5708-543f-bdfb-c00af9d98adc', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'accretion', '徐々の増大、堆積', '{}'::jsonb, null, null, 1),
  ('f31ea7d8-48b2-598d-8c1c-b69bcdee6f80', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'ameliorate', '改善する、緩和する', '{}'::jsonb, null, null, 2),
  ('cb278642-23bb-55a8-b7f5-eaab4e6a4fd2', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'apocryphal', '真偽の疑わしい、作り話の', '{}'::jsonb, null, null, 3),
  ('3ae75366-65c2-5ee9-b27f-d09360d968d1', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'axiomatic', '自明の、公理的な', '{}'::jsonb, null, null, 4),
  ('1ea9c00d-900e-5fda-9f74-7c01e20de735', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'bifurcate', '二つに分岐する', '{}'::jsonb, null, null, 5),
  ('a545d2e7-bf29-5743-8114-561fbec5b196', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'circumscribe', '制限する、範囲を限定する', '{}'::jsonb, null, null, 6),
  ('384d7d07-f2b7-517e-ae3b-c8c815eeb49d', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'cogent', '説得力のある', '{}'::jsonb, null, null, 7),
  ('5a0ab089-5e91-5a01-a514-fb699c2a4a06', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'commensurate', '釣り合った、相応の', '{}'::jsonb, null, null, 8),
  ('0271b123-292b-5e15-8fee-2a47b67001f9', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'conflation', '混同、融合', '{}'::jsonb, null, null, 9),
  ('5b6ae52e-c6b8-5acc-857d-a2e84e90aad9', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'congruent', '一致した、調和した', '{}'::jsonb, null, null, 10),
  ('0b52caeb-33d6-5241-9595-66602bad0cca', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'contingent', '〜次第の、偶発的な', '{}'::jsonb, null, null, 11),
  ('5ccfc8f2-0ce4-5283-9f56-d3fdd3ee08b6', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'contravene', '違反する、反する', '{}'::jsonb, null, null, 12),
  ('1c9cbbb8-e464-5fec-baca-20cac5e6ff58', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'deleterious', '有害な', '{}'::jsonb, null, null, 13),
  ('b4d32823-c75d-57a0-965d-061f553646a2', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'demarcate', '境界を定める', '{}'::jsonb, null, null, 14),
  ('b18aec2e-a14c-5ecf-8bfa-4cd3eb79239f', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'derivative', '派生した、独創性に乏しい', '{}'::jsonb, null, null, 15),
  ('fb65d30f-a0e8-5646-b38b-ccd0a3a9a609', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'desiccation', '乾燥、乾燥化', '{}'::jsonb, null, null, 16),
  ('e54549c0-1873-5fcb-8de3-01085db301d7', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'dichotomy', '二分法、二分', '{}'::jsonb, null, null, 17),
  ('fe61945e-fe4b-5113-8870-74ecde68c8df', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'diffuse', '拡散する、散在した', '{}'::jsonb, null, null, 18),
  ('a373a668-6363-5b14-8e63-04122f9acf9d', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'disaggregate', '分解する、細分化する', '{}'::jsonb, null, null, 19),
  ('2cf7bca4-fa9a-5786-b3ce-149abd3aa126', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'dissonance', '不一致、不調和', '{}'::jsonb, null, null, 20),
  ('7ea41c09-5c98-5c5a-9d3b-3f335c7a83fe', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'endogenous', '内生的な、内部から生じる', '{}'::jsonb, null, null, 21),
  ('db67b8be-1814-5f27-a724-bd09af5289e7', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'exogenous', '外生的な、外部から生じる', '{}'::jsonb, null, null, 22),
  ('379eeb3a-fab3-59b7-b60b-c66ad952d7d5', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'entrench', '定着させる、固定化する', '{}'::jsonb, null, null, 23),
  ('a2492e63-89c6-52ab-8f28-c90d96420814', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'epiphenomenon', '副次的現象', '{}'::jsonb, null, null, 24),
  ('0db30a08-0663-5b9e-bad4-140dbdb4883f', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'equivocate', '曖昧な言い方をする', '{}'::jsonb, null, null, 25),
  ('021e092b-d3a2-551c-9146-9b7841569803', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'esoteric', '難解な、専門家にしか分からない', '{}'::jsonb, null, null, 26),
  ('8d4803be-afdb-5c5e-b5d7-b11ebd9e53da', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'exacerbate', '悪化させる', '{}'::jsonb, null, null, 27),
  ('4af30000-e13b-508b-825e-82440ebfc298', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'extenuate', '軽減する、情状酌量する', '{}'::jsonb, null, null, 28),
  ('6d15be4a-5ba6-5740-805e-5a4546760335', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'fallacious', '誤った、論理的に不健全な', '{}'::jsonb, null, null, 29),
  ('dda5bac1-e1b5-5655-9eca-083a49c9edee', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'fecund', '多産な、生産力の高い', '{}'::jsonb, null, null, 30),
  ('7e9e6cf7-f966-59d5-a1c3-1c5fe4ebe954', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'fungible', '代替可能な', '{}'::jsonb, null, null, 31),
  ('962b1fb7-de4b-5158-b43a-72ffdaf7ddc2', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'heuristic', '発見的な、経験則に基づく', '{}'::jsonb, null, null, 32),
  ('4d0c26ec-383c-5d3d-9127-d888b20aa763', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'immutable', '不変の', '{}'::jsonb, null, null, 33),
  ('932b50f6-b072-56b2-96bc-67a0ccc1e188', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'impinge', '影響を及ぼす、侵害する', '{}'::jsonb, null, null, 34),
  ('f49b5e95-12ee-50a7-a4b7-3f97bcbf7115', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'inchoate', '未発達な、形成途中の', '{}'::jsonb, null, null, 35),
  ('28196d1c-470a-526e-98ec-cfd602ecfc29', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'inconsequential', '重要でない、取るに足らない', '{}'::jsonb, null, null, 36),
  ('563753b0-f35a-5292-87a3-ce08208e6791', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'incongruity', '不一致、不調和', '{}'::jsonb, null, null, 37),
  ('b4430a3c-c6c7-5642-9178-9cc8ac8af545', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'ineffable', '言葉では表現できない', '{}'::jsonb, null, null, 38),
  ('a1189981-6f8a-5a05-851b-17291a6b4886', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'intractable', '扱いにくい、解決困難な', '{}'::jsonb, null, null, 39),
  ('de774d44-19be-53c4-9ded-4a3d69ae6235', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'invoke', '援用する、持ち出す', '{}'::jsonb, null, null, 40),
  ('f827bd12-7639-52f9-a87d-d17c19440227', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'juxtaposition', '並置、対比', '{}'::jsonb, null, null, 41),
  ('7b20828d-50d7-5b8b-ab3d-a83fc7213394', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'lacuna', '欠落、空白', '{}'::jsonb, null, null, 42),
  ('166e6530-19c0-5adf-acd9-5cd51588ae88', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'malleability', '可塑性、変化しやすさ', '{}'::jsonb, null, null, 43),
  ('7e0c20dd-c308-50c1-9766-067bd285b764', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'mitigate', '緩和する', '{}'::jsonb, null, null, 44),
  ('31174e20-3e45-5064-bdc0-e3fe514bd4dd', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'obfuscate', '分かりにくくする、曖昧にする', '{}'::jsonb, null, null, 45),
  ('c138d513-b72a-5236-86ed-494242c3d1ad', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'parsimonious', '倹約的な、最小限の仮定による', '{}'::jsonb, null, null, 46),
  ('8fb7285f-a4fc-5ddb-9eb9-2002b2b637b4', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'peremptory', '断固とした、有無を言わせない', '{}'::jsonb, null, null, 47),
  ('87ae6b0b-a8be-5f11-a11b-e881eca677cf', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'pernicious', '有害な、破壊的な', '{}'::jsonb, null, null, 48),
  ('6f809b4f-cb10-5b20-bb7d-6890730b0219', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'precipitate', '引き起こす、促進する', '{}'::jsonb, null, null, 49),
  ('5c0bc1de-f064-5941-8267-4f6aa929e90f', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'preponderance', '優勢、大部分', '{}'::jsonb, null, null, 50),
  ('b01102c8-15e6-5436-ba72-49095342d280', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'prescriptive', '規範的な、指示的な', '{}'::jsonb, null, null, 51),
  ('62bd5823-d673-557a-ae93-3fce68cbfe99', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'probabilistic', '確率的な', '{}'::jsonb, null, null, 52),
  ('df0c23f4-aedd-5781-9b75-1c399a8914c0', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'protracted', '長引く、長期化した', '{}'::jsonb, null, null, 53),
  ('2a0028f1-e553-59ea-b525-8ad7c6c623ba', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'reify', '抽象概念を実体化する', '{}'::jsonb, null, null, 54),
  ('f9ddab2e-81b8-5f38-9d1c-71488188b0d8', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'repudiation', '拒絶、否認', '{}'::jsonb, null, null, 55),
  ('562821f2-703a-510a-841c-0593e86b55b6', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'salient', '顕著な、重要な', '{}'::jsonb, null, null, 56),
  ('5e5db197-2da5-5b35-8fc8-fe66d60f90ee', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'specious', '一見もっともらしいが誤った', '{}'::jsonb, null, null, 57),
  ('0db5b24b-dd4d-557e-bb7c-1a4a6fe75c67', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'stochastic', '確率的な、ランダムな', '{}'::jsonb, null, null, 58),
  ('66469fc1-9365-53da-b69c-2d25f06ac3d5', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'subsume', '包含する、下位概念として含める', '{}'::jsonb, null, null, 59),
  ('b5f85e60-346d-5a87-b8a6-f6883c4b6a49', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'superfluous', '余分な、不必要な', '{}'::jsonb, null, null, 60),
  ('74626fe8-ede4-585d-a737-c718d09304a0', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'taciturn', '無口な', '{}'::jsonb, null, null, 61),
  ('0fd95191-e3bc-5108-a9b4-62e7896be98f', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'tenuous', '薄弱な、わずかな', '{}'::jsonb, null, null, 62),
  ('fce8341d-f9b1-5621-99f6-26ff412dbf20', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'tractable', '扱いやすい、解決可能な', '{}'::jsonb, null, null, 63),
  ('a177b530-9cb9-5779-9190-a860644570b8', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'transitory', '一時的な', '{}'::jsonb, null, null, 64),
  ('6f893c36-1ebb-5635-baa9-c19926aaaf8e', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'ubiquitous', '至る所にある', '{}'::jsonb, null, null, 65),
  ('eca63610-f550-5e69-9726-3fb297d7d443', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'vacillate', '揺れ動く、決めかねる', '{}'::jsonb, null, null, 66),
  ('42a8967f-48fb-5da3-b1f1-869442c3ece1', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'veracity', '真実性、正確さ', '{}'::jsonb, null, null, 67),
  ('f32b9d8f-27a8-5203-84ec-cc0a9b60fc23', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'vicissitude', '変転、浮き沈み', '{}'::jsonb, null, null, 68),
  ('8778d908-b8a2-5a57-b156-8cdf50462879', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'anachronistic', '時代錯誤の', '{}'::jsonb, null, null, 69),
  ('5476ccc9-42ba-5844-8153-ca5541526a9c', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'anthropogenic', '人為起源の', '{}'::jsonb, null, null, 70),
  ('f000a18a-7a3d-549b-9c0b-204db7358289', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'asymmetrical', '非対称の', '{}'::jsonb, null, null, 71),
  ('43878002-7c52-5bfa-b92b-da77012afd52', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'attenuation', '弱化、減衰', '{}'::jsonb, null, null, 72),
  ('864daca1-dbd8-50d0-be74-5801528f4846', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'bifurcation', '分岐、二分', '{}'::jsonb, null, null, 73),
  ('e95756af-aa1c-5ec9-b1d8-dc81d64de18e', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'coercive', '強制的な', '{}'::jsonb, null, null, 74),
  ('5c5a280f-413f-586e-941e-efab673d72ef', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'corroborate', '裏付ける', '{}'::jsonb, null, null, 75),
  ('2e0d16d2-3b8f-5769-bd9a-ea0b8e52d3d0', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'countervailing', '相殺する、対抗する', '{}'::jsonb, null, null, 76),
  ('f65332b2-b7cf-5161-9fa3-19d1f686ce52', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'delineation', '明確な描写、区分', '{}'::jsonb, null, null, 77),
  ('bbec50d4-29a9-5178-aad7-084d22f74257', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'deterministic', '決定論的な', '{}'::jsonb, null, null, 78),
  ('9208a78a-6e95-5691-8bbd-1d8120c94315', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'disparate', '本質的に異なる', '{}'::jsonb, null, null, 79),
  ('263fdded-e62c-556b-af29-8162e603ac1e', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'epistemological', '認識論的な', '{}'::jsonb, null, null, 80),
  ('52f127c3-eb3d-5a8e-96f1-083ee0f7c6a9', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'extrapolation', '外挿、既知からの推定', '{}'::jsonb, null, null, 81),
  ('8ff44716-ba3b-5667-b3d4-0ec1832de57b', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'heterogeneity', '異質性、多様性', '{}'::jsonb, null, null, 82),
  ('06fb21bd-3c94-56bd-8e86-0d38cb7d700d', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'idiosyncratic', '特有の、独特な', '{}'::jsonb, null, null, 83),
  ('a54e7950-d04a-5076-9acb-e85d8c360501', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'inexorable', '止められない、避けられない', '{}'::jsonb, null, null, 84),
  ('96da8a58-ed28-5a17-80dd-182bf2cab37c', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'intrinsic', '本質的な、内在的な', '{}'::jsonb, null, null, 85),
  ('275eaed8-c933-5f6d-9230-0818fa467132', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'multifaceted', '多面的な', '{}'::jsonb, null, null, 86),
  ('c7066c89-c981-59a0-a4dc-eb204e94fa67', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'nominal', '名目上の、ごくわずかな', '{}'::jsonb, null, null, 87),
  ('80137744-b536-5200-962f-bde188cb7200', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'ontological', '存在論的な', '{}'::jsonb, null, null, 88),
  ('0c11bda7-95f8-5031-a8d6-8e95a9fa992f', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'oscillate', '振動する、変動する', '{}'::jsonb, null, null, 89),
  ('e719450c-8705-5f3a-a71f-08a045cdf446', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'paradigmatic', '模範的な、典型的な', '{}'::jsonb, null, null, 90),
  ('1658f6f7-29f0-56ce-9f88-a7d242bdf34d', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'paucity', '不足、少なさ', '{}'::jsonb, null, null, 91),
  ('201f9597-c197-5c5a-8152-eb5730fdd557', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'recalcitrant', '抵抗する、扱いにくい', '{}'::jsonb, null, null, 92),
  ('14efdcca-3653-5114-b6a8-651825347b05', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'recapitulate', '要約する、繰り返す', '{}'::jsonb, null, null, 93),
  ('75bad051-167a-5322-9d07-a934e550feef', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'retroactive', '遡及的な', '{}'::jsonb, null, null, 94),
  ('e5f57efd-c23d-561c-acee-387eb5ab1eec', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'synchronous', '同時の、同期した', '{}'::jsonb, null, null, 95),
  ('801c55f1-c34e-5515-ae44-892e89eb4a5d', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'transcend', '超越する', '{}'::jsonb, null, null, 96),
  ('daeb2f62-2831-5c5c-b54c-12e93bfe0cdb', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'undergird', '支える、基盤となる', '{}'::jsonb, null, null, 97),
  ('4b94f517-4145-52ff-b310-13bd4b3b8fc7', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'unsubstantiated', '根拠のない', '{}'::jsonb, null, null, 98),
  ('2d6fae70-81da-5a16-9c7a-5c63f24e5129', '68c17860-bcbd-5de3-92ed-47be695bf35a', 'expropriate', '接収する、収用する', '{}'::jsonb, null, null, 99);

-- =========================================================================
-- Generation note (for reproducibility)
-- =========================================================================
--
-- NAMESPACE_URL (RFC 4122 standard namespace for URLs):
--   6ba7b811-9dad-11d1-80b4-00c04fd430c8
--
-- Deck id = uuid5(NAMESPACE_URL, 'https://vocabbattle.app/starter-decks/<slug>')
--   Advanced English Vocabulary I (slug: advanced-english-vocabulary-i) = ff53281a-0e3d-5d2a-9356-29cf9589ef40
--   Advanced English Vocabulary II (slug: advanced-english-vocabulary-ii) = 68c17860-bcbd-5de3-92ed-47be695bf35a
--
-- Card id = uuid5(NAMESPACE_URL, 'https://vocabbattle.app/starter-decks/<slug>/cards/<sort_order zero-padded to 3 digits>/<front>')
-- where <slug> is the owning deck's slug above and <front> is the exact CSV
-- front value for that row.

