import csv
import io
import os
import sqlite3
from datetime import datetime

from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__)

# The database file always sits next to app.py, wherever you run it from
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "students.db")

VALID_STATUSES = ("present", "absent", "late")


def get_connection():
    connection = sqlite3.connect(DB_PATH)
    connection.execute("PRAGMA foreign_keys = ON")  # so deleting a student also deletes their attendance
    return connection


def setup_database():
    connection = get_connection()
    # Your old table stays exactly as it was
    connection.execute(
        "CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)"
    )
    # New table: one row per student per day
    connection.execute(
        """CREATE TABLE IF NOT EXISTS attendance (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               student_id INTEGER NOT NULL,
               date TEXT NOT NULL,
               status TEXT NOT NULL,
               UNIQUE (student_id, date),
               FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
           )"""
    )
    connection.commit()
    connection.close()


def is_valid_date(text):
    try:
        datetime.strptime(text, "%Y-%m-%d")
        return True
    except (ValueError, TypeError):
        return False


def clean_name(raw):
    """Returns (name, error). Checks empty and too long."""
    name = (raw or "").strip()
    if not name:
        return None, "Name cannot be empty"
    if len(name) > 50:
        return None, "Name must be 50 characters or less"
    return name, None


def name_exists(connection, name, ignore_id=None):
    rows = connection.execute(
        "SELECT id FROM students WHERE LOWER(name) = LOWER(?)", (name,)
    ).fetchall()
    return any(row[0] != ignore_id for row in rows)


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/students")
def get_students():
    date = request.args.get("date", "")
    if not is_valid_date(date):
        return jsonify({"error": "Invalid date"}), 400

    connection = get_connection()
    rows = connection.execute(
        """SELECT s.id, s.name, a.status,
                  (SELECT COUNT(*) FROM attendance WHERE student_id = s.id) AS marked,
                  (SELECT COUNT(*) FROM attendance
                    WHERE student_id = s.id AND status IN ('present', 'late')) AS attended
           FROM students s
           LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ?
           ORDER BY s.name COLLATE NOCASE""",
        (date,),
    ).fetchall()
    connection.close()

    students = []
    for row in rows:
        marked = row[3]
        percent = round(row[4] * 100 / marked) if marked else None  # None = no records yet
        students.append(
            {"id": row[0], "name": row[1] or "", "status": row[2], "percent": percent, "days": marked}
        )
    return jsonify(students)


@app.route("/add_student", methods=["POST"])
def add_student():
    data = request.get_json(silent=True) or {}
    name, error = clean_name(data.get("name"))
    if error:
        return jsonify({"error": error}), 400

    connection = get_connection()
    if name_exists(connection, name):
        connection.close()
        return jsonify({"error": "That student already exists"}), 400
    connection.execute("INSERT INTO students (name) VALUES (?)", (name,))
    connection.commit()
    connection.close()
    return jsonify({"message": "saved"})


@app.route("/students/<int:student_id>", methods=["PUT"])
def rename_student(student_id):
    data = request.get_json(silent=True) or {}
    name, error = clean_name(data.get("name"))
    if error:
        return jsonify({"error": error}), 400

    connection = get_connection()
    if name_exists(connection, name, ignore_id=student_id):
        connection.close()
        return jsonify({"error": "That student already exists"}), 400
    result = connection.execute("UPDATE students SET name = ? WHERE id = ?", (name, student_id))
    connection.commit()
    connection.close()
    if result.rowcount == 0:
        return jsonify({"error": "Student not found"}), 404
    return jsonify({"message": "updated"})


@app.route("/students/<int:student_id>", methods=["DELETE"])
def delete_student(student_id):
    connection = get_connection()
    connection.execute("DELETE FROM attendance WHERE student_id = ?", (student_id,))
    result = connection.execute("DELETE FROM students WHERE id = ?", (student_id,))
    connection.commit()
    connection.close()
    if result.rowcount == 0:
        return jsonify({"error": "Student not found"}), 404
    return jsonify({"message": "deleted"})


@app.route("/mark", methods=["POST"])
def mark_attendance():
    data = request.get_json(silent=True) or {}
    student_id = data.get("student_id")
    date = data.get("date")
    status = data.get("status")  # "present", "absent", "late", or None to clear

    if not isinstance(student_id, int) or not is_valid_date(date):
        return jsonify({"error": "Invalid request"}), 400
    if status is not None and status not in VALID_STATUSES:
        return jsonify({"error": "Invalid status"}), 400

    connection = get_connection()
    exists = connection.execute("SELECT 1 FROM students WHERE id = ?", (student_id,)).fetchone()
    if not exists:
        connection.close()
        return jsonify({"error": "Student not found"}), 404

    if status is None:
        connection.execute(
            "DELETE FROM attendance WHERE student_id = ? AND date = ?", (student_id, date)
        )
    else:
        connection.execute(
            """INSERT INTO attendance (student_id, date, status) VALUES (?, ?, ?)
               ON CONFLICT(student_id, date) DO UPDATE SET status = excluded.status""",
            (student_id, date, status),
        )
    connection.commit()
    connection.close()
    return jsonify({"message": "marked"})


def safe_cell(text):
    """Stops Excel from running a name like =1+1 as a formula."""
    text = str(text)
    if text and text[0] in "=+-@":
        return "'" + text
    return text


@app.route("/export")
def export_csv():
    connection = get_connection()
    rows = connection.execute(
        """SELECT s.name, a.date, a.status
           FROM attendance a JOIN students s ON s.id = a.student_id
           ORDER BY a.date DESC, s.name COLLATE NOCASE"""
    ).fetchall()
    connection.close()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Student", "Date", "Status"])
    for name, date, status in rows:
        writer.writerow([safe_cell(name or ""), date, status.capitalize()])

    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=attendance.csv"},
    )


setup_database()  # runs on import, so it also works under gunicorn later

if __name__ == "__main__":
    # debug=False because debug mode + host 0.0.0.0 lets anyone on your Wi-Fi run code on your PC
    # While developing alone, you can set debug=True and use host="127.0.0.1"
    app.run(host="0.0.0.0", port=5000, debug=False)
