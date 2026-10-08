-- Catálogo inicial de material de construção (100 produtos) para uma lojamestre.
--
-- Uso: troque o slug em v_slug, se for outra lojamestre, e rode o arquivo
-- inteiro conectado ao banco da aplicação:
--
--   psql "$DATABASE_URL" -f server/seeds/catalogo-material-construcao.sql
--
-- Também roda no pgAdmin/DBeaver (o resultado sai nas mensagens/notices).
-- Pode rodar mais de uma vez: produto com código que a lojamestre já tem é
-- pulado, nada é alterado nem duplicado. Os preços são de referência; revise
-- em Administração → Produtos antes de usar nos pedidos.
--
-- products tem RLS forçado por lojamestre, por isso o bloco define
-- app.tenant_id (só nesta transação) antes de inserir.
do $$
declare
  v_slug      text := 'confere';
  v_tenant_id bigint;
  v_inserted  integer;
  v_total     integer;
begin
  select id into v_tenant_id from tenants where lower(slug) = lower(v_slug);
  if v_tenant_id is null then
    raise exception 'Lojamestre "%" não encontrada. Slugs existentes: %',
      v_slug, (select string_agg(slug, ', ' order by slug) from tenants);
  end if;

  perform set_config('app.tenant_id', v_tenant_id::text, true);

  insert into products (tenant_id, code, name, unit, price)
  select v_tenant_id, v.code, v.name, v.unit, v.price
    from (values
      -- Cimentos, argamassas e gesso
      ('CIM-CP2',   'Cimento CP II-E-32 50 kg',                        'SC',  38.90),
      ('CIM-CP3',   'Cimento CP III-40 RS 50 kg',                      'SC',  39.90),
      ('CIM-CP5',   'Cimento CP V-ARI 40 kg',                          'SC',  41.50),
      ('CIM-BRA5',  'Cimento branco 5 kg',                             'UN',  22.90),
      ('ARG-AC1',   'Argamassa AC-I interna 20 kg',                    'SC',  18.50),
      ('ARG-AC2',   'Argamassa AC-II interna e externa 20 kg',         'SC',  27.90),
      ('ARG-AC3',   'Argamassa AC-III 20 kg',                          'SC',  42.90),
      ('ARG-ASS',   'Argamassa para assentamento de alvenaria 20 kg',  'SC',  16.90),
      ('ARG-REB',   'Argamassa para reboco 20 kg',                     'SC',  17.90),
      ('CAL-HID',   'Cal hidratada CH-III 20 kg',                      'SC',  16.90),
      ('GES-40',    'Gesso em pó 40 kg',                               'SC',  44.90),
      -- Agregados
      ('ARE-FIN',   'Areia fina lavada',                               'M³', 150.00),
      ('ARE-MED',   'Areia média lavada',                              'M³', 145.00),
      ('ARE-GRO',   'Areia grossa lavada',                             'M³', 140.00),
      ('ARE-SC20',  'Areia média ensacada 20 kg',                      'SC',   7.90),
      ('BRI-00',    'Pedrisco (brita 0)',                              'M³', 165.00),
      ('BRI-01',    'Brita 1',                                         'M³', 160.00),
      -- Alvenaria
      ('TIJ-6F',    'Tijolo cerâmico 6 furos 9x14x19',                 'UN',   0.95),
      ('TIJ-8F',    'Tijolo cerâmico 8 furos 9x19x19',                 'UN',   1.35),
      ('TIJ-MAC',   'Tijolo maciço comum',                             'UN',   0.85),
      ('BLO-09',    'Bloco de concreto 9x19x39',                       'UN',   3.20),
      ('BLO-14',    'Bloco de concreto 14x19x39',                      'UN',   4.20),
      ('BLO-19',    'Bloco de concreto 19x19x39',                      'UN',   5.40),
      ('CAN-14',    'Canaleta de concreto 14x19x39',                   'UN',   4.90),
      -- Aço e ferragens
      ('VER-063',   'Vergalhão CA-50 6,3 mm barra 12 m',               'BR',  24.90),
      ('VER-08',    'Vergalhão CA-50 8 mm barra 12 m',                 'BR',  36.50),
      ('VER-10',    'Vergalhão CA-50 10 mm barra 12 m',                'BR',  54.90),
      ('VER-125',   'Vergalhão CA-50 12,5 mm barra 12 m',              'BR',  84.90),
      ('VER-042',   'Vergalhão CA-60 4,2 mm barra 12 m',               'BR',  12.90),
      ('ARA-18',    'Arame recozido nº 18',                            'KG',  19.90),
      ('TEL-Q92',   'Tela soldada Q-92 2 x 3 m',                       'PC',  89.00),
      ('COL-99',    'Coluna armada 9x9 cm barra 6 m',                  'PC',  59.90),
      ('TRE-H8',    'Treliça H8 barra 6 m',                            'PC',  39.90),
      -- Pregos e fixação
      ('PRE-1515',  'Prego com cabeça 15x15',                          'KG',  21.90),
      ('PRE-1727',  'Prego com cabeça 17x27',                          'KG',  18.90),
      ('PRE-1830',  'Prego com cabeça 18x30',                          'KG',  18.90),
      ('BUC-06',    'Bucha de nylon nº 6 caixa com 100',               'CX',  14.90),
      ('PAR-4540',  'Parafuso chipboard 4,5 x 40 mm caixa com 100',    'CX',  24.90),
      ('ESP-PU',    'Espuma expansiva de poliuretano 500 ml',          'UN',  32.90),
      -- Madeiras
      ('MAD-TAB30', 'Tábua de pinus 30 cm x 3 m',                      'PC',  34.90),
      ('MAD-SAR',   'Sarrafo de pinus 5 cm x 3 m',                     'PC',   7.90),
      ('MAD-PON',   'Pontalete de eucalipto 7 x 7 cm x 3 m',           'PC',  18.90),
      ('MAD-COM',   'Compensado resinado 10 mm 1,10 x 2,20 m',         'PC',  79.90),
      -- Hidráulica
      ('TUB-20',    'Tubo PVC soldável 20 mm barra 6 m',               'BR',  18.90),
      ('TUB-25',    'Tubo PVC soldável 25 mm barra 6 m',               'BR',  24.90),
      ('TUB-32',    'Tubo PVC soldável 32 mm barra 6 m',               'BR',  44.90),
      ('TUB-E40',   'Tubo PVC esgoto 40 mm barra 6 m',                 'BR',  32.90),
      ('TUB-E50',   'Tubo PVC esgoto 50 mm barra 6 m',                 'BR',  44.90),
      ('TUB-100',   'Tubo PVC esgoto 100 mm barra 6 m',                'BR',  69.90),
      ('JOE-25',    'Joelho PVC soldável 90° 25 mm',                   'UN',   1.80),
      ('JOE-E100',  'Joelho PVC esgoto 90° 100 mm',                    'UN',   9.90),
      ('TEE-25',    'Tê PVC soldável 25 mm',                           'UN',   2.40),
      ('LUV-25',    'Luva PVC soldável 25 mm',                         'UN',   1.20),
      ('REG-ESF25', 'Registro de esfera PVC soldável 25 mm',           'UN',  14.90),
      ('REG-GAV34', 'Registro de gaveta bruto 3/4"',                   'UN',  54.90),
      ('CXA-500',   'Caixa d''água polietileno 500 L',                 'UN', 329.00),
      ('CXA-1000',  'Caixa d''água polietileno 1.000 L',               'UN', 499.00),
      ('CXS-100',   'Caixa sifonada 100x100x50 mm com grelha',         'UN',  19.90),
      ('ADE-PVC',   'Adesivo para PVC 175 g',                          'UN',  18.90),
      ('VED-ROS',   'Fita veda-rosca 18 mm x 25 m',                    'UN',   6.90),
      -- Elétrica
      ('CAB-15',    'Cabo flexível 1,5 mm² rolo 100 m',                'RL', 159.00),
      ('CAB-25',    'Cabo flexível 2,5 mm² rolo 100 m',                'RL', 239.00),
      ('CAB-40',    'Cabo flexível 4 mm² rolo 100 m',                  'RL', 379.00),
      ('ELE-20',    'Eletroduto corrugado 20 mm rolo 50 m',            'RL',  49.90),
      ('CXL-4X2',   'Caixa de luz 4x2 de embutir',                     'UN',   1.90),
      ('TOM-10A',   'Tomada 2P+T 10 A com placa',                      'UN',  12.90),
      ('INT-SIM',   'Interruptor simples 10 A com placa',              'UN',  11.90),
      ('DIS-20',    'Disjuntor monopolar DIN 20 A',                    'UN',  14.90),
      ('QDD-12',    'Quadro de distribuição de embutir 12 disjuntores','UN',  79.90),
      ('FIT-ISO',   'Fita isolante 19 mm x 20 m',                      'UN',   8.90),
      ('LAM-LED9',  'Lâmpada LED bulbo 9 W luz branca',                'UN',   9.90),
      -- Tintas e pintura
      ('TIN-ACR18', 'Tinta acrílica fosca branco neve 18 L',           'LT', 389.00),
      ('TIN-PVA18', 'Tinta látex PVA branca 18 L',                     'LT', 219.00),
      ('TIN-ESM36', 'Esmalte sintético branco brilhante 3,6 L',        'LT', 119.00),
      ('SEL-ACR18', 'Selador acrílico 18 L',                           'LT', 179.00),
      ('MAS-COR25', 'Massa corrida PVA 25 kg',                         'UN',  79.90),
      ('MAS-ACR25', 'Massa acrílica 25 kg',                            'UN', 119.00),
      ('TEX-ACR25', 'Textura acrílica 25 kg',                          'UN',  99.90),
      ('ROL-23',    'Rolo de lã 23 cm com cabo',                       'UN',  24.90),
      ('TRI-2',     'Trincha 2"',                                      'UN',   9.90),
      ('FIT-CRE',   'Fita crepe 48 mm x 50 m',                         'UN',  12.90),
      -- Impermeabilização
      ('IMP-18',    'Impermeabilizante acrílico 18 L',                 'UN', 259.00),
      ('IMP-MAN3',  'Manta asfáltica 3 mm rolo 10 m',                  'RL', 219.00),
      ('IMP-ARG18', 'Argamassa polimérica impermeabilizante 18 kg',    'CX',  89.90),
      -- Pisos e revestimentos
      ('POR-6060',  'Porcelanato acetinado 60x60 cm',                  'M²',  79.90),
      ('PIS-4545',  'Piso cerâmico 45x45 cm PEI 4',                    'M²',  34.90),
      ('REV-3060',  'Revestimento cerâmico de parede 30x60 cm',        'M²',  39.90),
      ('REJ-CZ1',   'Rejunte flexível cinza 1 kg',                     'KG',   9.90),
      ('REJ-BR1',   'Rejunte flexível branco 1 kg',                    'KG',   9.90),
      -- Cobertura
      ('TEL-FIB6',  'Telha de fibrocimento 2,44 x 1,10 m 6 mm',        'UN',  69.90),
      ('TEL-CER',   'Telha cerâmica portuguesa',                       'UN',   2.90),
      ('CUM-FIB6',  'Cumeeira de fibrocimento 6 mm',                   'UN',  34.90),
      -- Ferramentas e EPI
      ('FER-CAR',   'Carrinho de mão 60 L pneu com câmara',            'UN', 249.00),
      ('FER-PA',    'Pá de bico com cabo',                             'UN',  59.90),
      ('FER-COL',   'Colher de pedreiro 8"',                           'UN',  24.90),
      ('FER-DES',   'Desempenadeira de aço dentada 12 x 25 cm',        'UN',  29.90),
      ('FER-NIV',   'Nível de alumínio 40 cm',                         'UN',  34.90),
      ('FER-TRE',   'Trena 5 m',                                       'UN',  19.90),
      ('EPI-LUV',   'Luva de raspa',                                   'PAR', 12.90),
      ('LON-46',    'Lona plástica preta 4 x 6 m',                     'PC',  39.90)
    ) as v (code, name, unit, price)
  on conflict (tenant_id, lower(code)) where code is not null do nothing;

  get diagnostics v_inserted = row_count;
  select count(*) into v_total from products where tenant_id = v_tenant_id;
  raise notice 'Lojamestre "%" (id %): % produtos inseridos, % no catálogo.',
    v_slug, v_tenant_id, v_inserted, v_total;
end $$;
