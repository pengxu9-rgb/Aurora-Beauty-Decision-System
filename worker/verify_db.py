import os
import re
from typing import List, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import psycopg2
from dotenv import load_dotenv


ENV_TEMPLATE_RE = re.compile(r"\$\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def _require_env(name: str) -> str:
  value = (os.getenv(name) or "").strip()
  if not value:
    raise RuntimeError(f"Missing required env var: {name}")
  return value


def resolve_env_templates(value: str) -> str:
  if "${{" not in value:
    return value

  missing: List[str] = []

  def _repl(match: re.Match[str]) -> str:
    key = match.group(1)
    resolved = (os.getenv(key) or "").strip()
    if not resolved:
      missing.append(key)
      return match.group(0)
    return resolved

  rendered = ENV_TEMPLATE_RE.sub(_repl, value)
  if missing:
    raise RuntimeError(
      "DATABASE_URL contains Railway template placeholders that are not resolvable locally: "
      + ", ".join(sorted(set(missing)))
      + ".\nFix: set DATABASE_URL to Railway Postgres **Public connection string** (with real host/port)."
    )
  return rendered


def sanitize_psycopg2_database_url(dsn: str) -> str:
  # psycopg2/libpq doesn't accept Prisma's `schema=` URI query parameter.
  try:
    u = urlparse(dsn)
    if u.scheme and u.netloc:
      q = [(k, v) for (k, v) in parse_qsl(u.query, keep_blank_values=True) if k.lower() != "schema"]
      return urlunparse((u.scheme, u.netloc, u.path, u.params, urlencode(q), u.fragment))
  except Exception:  # noqa: BLE001
    return dsn
  return dsn


def main() -> None:
  dotenv_path = os.path.join(os.getcwd(), ".env")
  if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path=dotenv_path)
  else:
    load_dotenv()

  dsn = sanitize_psycopg2_database_url(resolve_env_templates(_require_env("DATABASE_URL")))

  conn = psycopg2.connect(dsn)
  try:
    with conn.cursor() as cur:
      cur.execute("select extname from pg_extension where extname='vector';")
      has_vector = cur.fetchone() is not None

      cur.execute('select count(*) from "products";')
      products = cur.fetchone()[0]
      cur.execute('select count(*) from "sku_vectors";')
      sku_vectors = cur.fetchone()[0]
      cur.execute('select count(*) from "ingredients";')
      ingredients = cur.fetchone()[0]
      cur.execute('select count(*) from "social_stats";')
      social_stats = cur.fetchone()[0]

      print("db_ok: true")
      print(f"pgvector_installed: {has_vector}")
      print(f"counts: products={products} sku_vectors={sku_vectors} ingredients={ingredients} social_stats={social_stats}")

      cur.execute(
        """
        select p.brand, p.name, (v.product_id is not null) as has_vectors, (i.product_id is not null) as has_ingredients
          from "products" p
          left join "sku_vectors" v on v.product_id = p.id
          left join "ingredients" i on i.product_id = p.id
         order by p.created_at desc
         limit 20;
        """
      )
      rows: List[Tuple[str, str, bool, bool]] = cur.fetchall()
      print("latest_products (up to 20):")
      for brand, name, has_vec, has_ing in rows:
        print(f"- {brand} | {name} | vectors={has_vec} ingredients={has_ing}")

      # Demo products
      cur.execute(
        """
        select p.brand,
               p.name,
               (v.embedding is not null) as has_embedding,
               coalesce(vector_dims(v.embedding), 0) as embedding_dim,
               coalesce(array_length(v.risk_flags, 1), 0) as risk_flags_count
          from "products" p
          left join "sku_vectors" v on v.product_id = p.id
         where (p.brand, p.name) in (
            ('Tom Ford', 'Research Serum Concentrate'),
            ('The Ordinary', 'Buffet + Copper Peptides 1%'),
            ('Helena Rubinstein', 'Re-Plasty Age Recovery Night Cream (Black Bandage)')
         )
         order by p.brand asc;
        """
      )
      demo = cur.fetchall()
      print("demo_products:")
      for brand, name, has_embedding, embedding_dim, risk_flags_count in demo:
        print(
          f"- {brand} | {name} | embedding={bool(has_embedding)} dim={int(embedding_dim or 0)} risk_flags={int(risk_flags_count or 0)}"
        )
  finally:
    conn.close()


if __name__ == "__main__":
  main()

