"""Export every table of a Tableau .hyper extract to CSV.

Usage:
  python -I hyper_export.py --hyper <file.hyper> --out <dir>
  python -I hyper_export.py --check

Prints one JSON object on the last stdout line:
  export: {"hyperApiVersion", "tables": [{"schema", "name", "file", "rowCount", "columns": [{"name", "type", "nullable"}]}]}
  check:  {"ok": true, "version"}
  error:  {"error", "code"?} with a non-zero exit code
"""

import argparse
import csv
import json
import os
import re
import shutil
import sys
import tempfile


def emit(payload):
    sys.stdout.write(json.dumps(payload) + '\n')
    sys.stdout.flush()


def fail(message, code='error', status=1):
    emit({'error': message, 'code': code})
    sys.exit(status)


def load_hyperapi():
    try:
        import tableauhyperapi  # noqa: F401
        return tableauhyperapi
    except ImportError as err:
        fail(
            'The tableauhyperapi Python package is not installed for %s (%s). '
            'Run: %s -m pip install tableauhyperapi' % (sys.executable, err, sys.executable),
            code='missing-module',
            status=3,
        )


def api_version(api):
    version = getattr(api, '__version__', None)
    if version:
        return str(version)
    try:
        from importlib.metadata import version as dist_version
        return dist_version('tableauhyperapi')
    except Exception:
        return 'unknown'


SQL_NAMES = {
    'BIG_INT': 'BIGINT',
    'SMALL_INT': 'SMALLINT',
    'INT': 'INTEGER',
    'BOOL': 'BOOL',
    'DOUBLE': 'DOUBLE',
    'FLOAT': 'REAL',
    'TIMESTAMP_TZ': 'TIMESTAMP_TZ',
}


def type_name(sql_type):
    tag = getattr(getattr(sql_type, 'tag', None), 'name', None)
    if tag is None:
        return str(sql_type).upper()
    if tag == 'NUMERIC':
        precision = getattr(sql_type, 'precision', None)
        scale = getattr(sql_type, 'scale', None)
        if precision is not None:
            return 'NUMERIC(%d,%d)' % (precision, scale or 0)
        return 'NUMERIC'
    return SQL_NAMES.get(tag, tag)


def unescaped(name):
    value = getattr(name, 'unescaped', None)
    if value is not None:
        return value
    text = str(name)
    if text.startswith('"') and text.endswith('"'):
        return text[1:-1].replace('""', '"')
    return text


def schema_label(schema):
    name = getattr(schema, 'name', None)
    return unescaped(name if name is not None else schema)


def safe_file_name(schema, table, used):
    base = re.sub(r'[^A-Za-z0-9._-]+', '_', '%s.%s' % (schema, table)).strip('._') or 'table'
    base = base[:120]
    candidate = base
    n = 2
    while candidate.lower() in used:
        candidate = '%s_%d' % (base, n)
        n += 1
    used.add(candidate.lower())
    return candidate + '.csv'


def text_value(value):
    if value is None:
        return ''
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    return str(value)


def copy_to_csv(api, connection, table_sql, out_file):
    """COPY TO needs Hyper API 0.0.17360+; option syntax differs between releases."""
    target = api.escape_string_literal(out_file)
    errors = []
    for options in ('(FORMAT csv, HEADER)', "(FORMAT => 'csv', HEADER => true)"):
        if os.path.exists(out_file):
            os.remove(out_file)
        try:
            count = connection.execute_command('COPY (SELECT * FROM %s) TO %s WITH %s' % (table_sql, target, options))
            return count
        except api.HyperException as err:
            errors.append(str(err).splitlines()[0] if str(err) else repr(err))
    raise RuntimeError('; '.join(errors))


def stream_to_csv(connection, table_sql, columns, out_file):
    count = 0
    with open(out_file, 'w', newline='', encoding='utf-8') as handle:
        writer = csv.writer(handle, lineterminator='\n')
        writer.writerow([c['name'] for c in columns])
        with connection.execute_query('SELECT * FROM %s' % table_sql) as result:
            for row in result:
                writer.writerow([text_value(v) for v in row])
                count += 1
    return count


def export(hyper_file, out_dir):
    api = load_hyperapi()
    from tableauhyperapi import Connection, CreateMode, HyperProcess, Nullability, Telemetry

    if not os.path.isfile(hyper_file):
        fail('Hyper file not found: %s' % hyper_file, code='not-found')
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    log_dir = tempfile.mkdtemp(prefix='t2d-hyper-log-')
    tables = []
    used = set()
    try:
        with HyperProcess(
            telemetry=Telemetry.DO_NOT_SEND_USAGE_DATA_TO_TABLEAU,
            parameters={'log_dir': log_dir},
        ) as hyper:
            with Connection(endpoint=hyper.endpoint, database=os.path.abspath(hyper_file), create_mode=CreateMode.NONE) as connection:
                catalog = connection.catalog
                for schema in catalog.get_schema_names():
                    for table in catalog.get_table_names(schema):
                        definition = catalog.get_table_definition(table)
                        columns = [
                            {
                                'name': unescaped(column.name),
                                'type': type_name(column.type),
                                'nullable': column.nullability == Nullability.NULLABLE,
                            }
                            for column in definition.columns
                        ]
                        schema_name = schema_label(getattr(table, 'schema_name', None) or schema)
                        table_name = unescaped(table.name)
                        out_file = os.path.join(out_dir, safe_file_name(schema_name, table_name, used))
                        table_sql = str(table)
                        method = 'copy'
                        try:
                            copy_to_csv(api, connection, table_sql, out_file)
                        except Exception:
                            method = 'stream'
                            stream_to_csv(connection, table_sql, columns, out_file)
                        row_count = connection.execute_scalar_query('SELECT COUNT(*) FROM %s' % table_sql)
                        tables.append({
                            'schema': schema_name,
                            'name': table_name,
                            'file': out_file,
                            'rowCount': int(row_count or 0),
                            'method': method,
                            'columns': columns,
                        })
    finally:
        shutil.rmtree(log_dir, ignore_errors=True)
    emit({'hyperApiVersion': api_version(api), 'tables': tables})


def main():
    parser = argparse.ArgumentParser(description='Export a Tableau .hyper extract to CSV files')
    parser.add_argument('--hyper')
    parser.add_argument('--out')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()

    if args.check:
        api = load_hyperapi()
        emit({'ok': True, 'version': api_version(api), 'python': sys.version.split()[0]})
        return
    if not args.hyper or not args.out:
        fail('--hyper and --out are required', code='usage', status=2)
    try:
        export(args.hyper, args.out)
    except SystemExit:
        raise
    except Exception as err:
        fail('%s: %s' % (type(err).__name__, err))


if __name__ == '__main__':
    main()
