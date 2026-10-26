package jp.jphacks.tkb2633

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

internal object WidgetCompletionDatabase {
  fun complete(context: Context, scheduleEntryId: String): Boolean {
    val databaseFile = File(context.filesDir, "SQLite/housework.db")
    if (!databaseFile.exists()) return false

    val database = SQLiteDatabase.openDatabase(
      databaseFile.path,
      null,
      SQLiteDatabase.OPEN_READWRITE
    )
    try {
      database.execSQL("PRAGMA foreign_keys = ON")
      database.beginTransaction()
      try {
        val entry = database.rawQuery(
          """SELECT e.household_id, e.chore_id, e.window_start, e.window_end, e.suggested_date
            FROM chore_schedule_entries e JOIN chore_definitions d
              ON d.id = e.chore_id AND d.household_id = e.household_id
            WHERE e.id = ? AND d.enabled = 1""",
          arrayOf(scheduleEntryId)
        ).use { cursor ->
          if (!cursor.moveToFirst()) return false
          ScheduleEntry(
            householdId = cursor.getString(0),
            choreId = cursor.getString(1),
            windowStart = cursor.getString(2),
            windowEnd = cursor.getString(3),
            suggestedDate = cursor.getString(4)
          )
        }

        val currentState = database.rawQuery(
          "SELECT last_completed_date, last_completed_estimated, initial_pending, initial_scheduled_date, unknown_reason FROM chore_state WHERE chore_id = ?",
          arrayOf(entry.choreId)
        ).use { cursor ->
          if (!cursor.moveToFirst()) null else {
            JSONObject()
              .put("choreId", entry.choreId)
              .put("lastCompletedEstimated", cursor.getInt(1) != 0)
              .put("initialPending", cursor.getInt(2) != 0)
              .also { state ->
                cursor.getString(0)?.let { state.put("lastCompletedDate", it) }
                cursor.getString(3)?.let { state.put("initialScheduledDate", it) }
                cursor.getString(4)?.let { state.put("unknownReason", it) }
              }
          }
        }
        val previousStateJson = currentState?.toString() ?: "null"
        val completedAt = utcTimestamp()
        val completionId = database.rawQuery(
          "SELECT id, outcome FROM chore_completions WHERE schedule_entry_id = ?",
          arrayOf(scheduleEntryId)
        ).use { cursor ->
          if (!cursor.moveToFirst()) null else {
            val existingId = cursor.getString(0)
            if (cursor.getString(1) == "completed") return false
            existingId
          }
        }

        if (completionId == null) {
          database.execSQL(
            """INSERT INTO chore_completions
              (id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id,
               scheduled_date, scheduled_window_start, scheduled_window_end, outcome, previous_chore_state_json)
              VALUES (?, ?, ?, ?, NULL, 'widget', ?, ?, ?, ?, 'completed', ?)""",
            arrayOf(
              newCompletionId(), entry.householdId, entry.choreId, completedAt, scheduleEntryId,
              entry.suggestedDate, entry.windowStart, entry.windowEnd, previousStateJson
            )
          )
        } else {
          database.execSQL(
            """UPDATE chore_completions SET outcome = 'completed', completed_at = ?,
              completed_by_member_id = NULL, source = 'widget', scheduled_date = ?,
              scheduled_window_start = ?, scheduled_window_end = ?, previous_chore_state_json = ? WHERE id = ?""",
            arrayOf(
              completedAt, entry.suggestedDate, entry.windowStart, entry.windowEnd,
              previousStateJson, completionId
            )
          )
        }

        // The broadcast may run before any JS listener exists. Keep the same
        // durable local-intent marker as in-app completion/undo, in this transaction.
        // A widget can be tapped after an APK update but before JS migrates an
        // older database. The completion timestamp also supports recovery then.
        if (hasPendingStatusColumns(database)) {
          database.execSQL(
            "UPDATE google_task_links SET pending_status = 'completed', pending_status_revision = ? WHERE schedule_entry_id = ?",
            arrayOf("google-status-${UUID.randomUUID()}", scheduleEntryId)
          )
        }

        val completedDate = localDate()
        val previousCompletedDate = currentState?.optString("lastCompletedDate")?.takeIf { it.isNotEmpty() }
        if (completedDate >= entry.windowStart && (previousCompletedDate == null || completedDate >= previousCompletedDate)) {
          database.execSQL(
            """INSERT INTO chore_state
              (chore_id, last_completed_date, last_completed_estimated, initial_pending, unknown_reason)
              VALUES (?, ?, 0, 0, NULL)
              ON CONFLICT(chore_id) DO UPDATE SET last_completed_date = excluded.last_completed_date,
              last_completed_estimated = 0, initial_pending = 0, initial_scheduled_date = NULL, unknown_reason = NULL""",
            arrayOf(entry.choreId, completedDate)
          )
        }
        database.setTransactionSuccessful()
      } finally {
        database.endTransaction()
      }
    } finally {
      database.close()
    }
    return true
  }

  private fun hasPendingStatusColumns(database: SQLiteDatabase): Boolean =
    database.rawQuery("PRAGMA table_info(google_task_links)", null).use { cursor ->
      val nameIndex = cursor.getColumnIndexOrThrow("name")
      val columns = mutableSetOf<String>()
      while (cursor.moveToNext()) columns.add(cursor.getString(nameIndex))
      columns.containsAll(listOf("pending_status", "pending_status_revision"))
    }

  private fun utcTimestamp(): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
    timeZone = TimeZone.getTimeZone("UTC")
  }.format(Date())

  private fun localDate(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

  private fun newCompletionId(): String = "completion-${System.currentTimeMillis().toString(36)}-${UUID.randomUUID().toString().take(7)}"

  private data class ScheduleEntry(
    val householdId: String,
    val choreId: String,
    val windowStart: String,
    val windowEnd: String,
    val suggestedDate: String
  )
}
