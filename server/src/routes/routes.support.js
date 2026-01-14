import { Router } from "express";
import { requireAuth } from "../auth.js";
import { get, all, run } from "../db.js";

const router = Router();

/* -----------------------------
   CREATE TICKET
------------------------------ */
router.post("/tickets", requireAuth, async (req, res) => {
  try {
    const { subject, description, category, priority } = req.body;
    
    if (!subject || !description) {
      return res.status(400).json({ error: "subject_and_description_required" });
    }
    
    const validCategories = ["technical", "billing", "account", "general", "bug_report", "feature_request"];
    const validPriorities = ["low", "medium", "high", "urgent"];
    
    const ticketCategory = validCategories.includes(category) ? category : "general";
    const ticketPriority = validPriorities.includes(priority) ? priority : "medium";
    
    const ticketNumber = `TICK-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    
    const result = await run(
      `INSERT INTO support_tickets (
        ticket_number, user_id, subject, description, 
        category, priority, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      [ticketNumber, req.user.uid, subject, description, ticketCategory, ticketPriority, Date.now()]
    );
    
    // Create initial message
    await run(
      `INSERT INTO support_messages (
        ticket_id, user_id, message, is_staff_reply, created_at
      ) VALUES (?, ?, ?, 0, ?)`,
      [result.lastID, req.user.uid, description, Date.now()]
    );
    
    res.json({ 
      success: true, 
      ticket_id: result.lastID,
      ticket_number: ticketNumber
    });
  } catch (err) {
    console.error("[Support] Error creating ticket:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   GET USER'S TICKETS
------------------------------ */
router.get("/tickets", requireAuth, async (req, res) => {
  try {
    const { status, category } = req.query;
    
    let sql = `
      SELECT 
        t.id, t.ticket_number, t.subject, t.category, 
        t.priority, t.status, t.created_at, t.updated_at,
        u.username as user_name,
        (SELECT COUNT(*) FROM support_messages WHERE ticket_id = t.id) as message_count,
        (SELECT created_at FROM support_messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) as last_message_at
      FROM support_tickets t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.user_id = ?
    `;
    
    const params = [req.user.uid];
    
    if (status && status !== "all") {
      sql += ` AND t.status = ?`;
      params.push(status);
    }
    
    if (category && category !== "all") {
      sql += ` AND t.category = ?`;
      params.push(category);
    }
    
    sql += ` ORDER BY t.created_at DESC`;
    
    const tickets = await all(sql, params);
    res.json({ tickets });
  } catch (err) {
    console.error("[Support] Error fetching tickets:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   GET SINGLE TICKET DETAILS
------------------------------ */
router.get("/tickets/:id", requireAuth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id);
    
    const ticket = await get(
      `SELECT 
        t.*, 
        u.username as user_name,
        u.email as user_email,
        a.username as assigned_to_name
      FROM support_tickets t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users a ON t.assigned_to = a.id
      WHERE t.id = ?`,
      [ticketId]
    );
    
    if (!ticket) {
      return res.status(404).json({ error: "ticket_not_found" });
    }
    
    // Check permissions
    const isStaff = req.user.role === "admin" || req.user.role === "moderator";
    if (ticket.user_id !== req.user.uid && !isStaff) {
      return res.status(403).json({ error: "not_authorized" });
    }
    
    // Get messages
    const messages = await all(
      `SELECT 
        m.id, m.message, m.is_staff_reply, m.created_at,
        u.username, u.role
      FROM support_messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.ticket_id = ?
      ORDER BY m.created_at ASC`,
      [ticketId]
    );
    
    res.json({ ticket, messages });
  } catch (err) {
    console.error("[Support] Error fetching ticket:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   ADD MESSAGE TO TICKET
------------------------------ */
router.post("/tickets/:id/messages", requireAuth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { message } = req.body;
    
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: "message_required" });
    }
    
    const ticket = await get(
      `SELECT user_id, status FROM support_tickets WHERE id = ?`,
      [ticketId]
    );
    
    if (!ticket) {
      return res.status(404).json({ error: "ticket_not_found" });
    }
    
    const isStaff = req.user.role === "admin" || req.user.role === "moderator";
    if (ticket.user_id !== req.user.uid && !isStaff) {
      return res.status(403).json({ error: "not_authorized" });
    }
    
    // Check if ticket is closed
    if (ticket.status === "closed" && !isStaff) {
      return res.status(400).json({ error: "ticket_closed" });
    }
    
    const result = await run(
      `INSERT INTO support_messages (
        ticket_id, user_id, message, is_staff_reply, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [ticketId, req.user.uid, message, isStaff ? 1 : 0, Date.now()]
    );
    
    // Update ticket timestamp and status
    let newStatus = ticket.status;
    if (ticket.status === "closed" && isStaff) {
      // Staff can reopen by replying
      newStatus = "open";
    } else if (isStaff && ticket.status === "open") {
      // Staff reply marks as awaiting user
      newStatus = "awaiting_user";
    } else if (!isStaff && ticket.status === "awaiting_user") {
      // User reply marks as open
      newStatus = "open";
    }
    
    await run(
      `UPDATE support_tickets SET updated_at = ?, status = ? WHERE id = ?`,
      [Date.now(), newStatus, ticketId]
    );
    
    res.json({ success: true, message_id: result.lastID });
  } catch (err) {
    console.error("[Support] Error adding message:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   UPDATE TICKET STATUS (USER)
------------------------------ */
router.patch("/tickets/:id/status", requireAuth, async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { status } = req.body;
    
    const ticket = await get(
      `SELECT user_id FROM support_tickets WHERE id = ?`,
      [ticketId]
    );
    
    if (!ticket) {
      return res.status(404).json({ error: "ticket_not_found" });
    }
    
    if (ticket.user_id !== req.user.uid) {
      return res.status(403).json({ error: "not_authorized" });
    }
    
    // Users can only close their own tickets
    if (status === "closed") {
      await run(
        `UPDATE support_tickets SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
        ["closed", Date.now(), Date.now(), ticketId]
      );
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "invalid_status" });
    }
  } catch (err) {
    console.error("[Support] Error updating ticket:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   STAFF: GET ALL TICKETS
------------------------------ */
router.get("/staff/tickets", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "moderator") {
      return res.status(403).json({ error: "not_authorized" });
    }
    
    const { status, category, priority, assigned } = req.query;
    
    let sql = `
      SELECT 
        t.id, t.ticket_number, t.subject, t.category, 
        t.priority, t.status, t.created_at, t.updated_at,
        u.username as user_name,
        a.username as assigned_to_name,
        (SELECT COUNT(*) FROM support_messages WHERE ticket_id = t.id) as message_count,
        (SELECT created_at FROM support_messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) as last_message_at
      FROM support_tickets t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users a ON t.assigned_to = a.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (status && status !== "all") {
      sql += ` AND t.status = ?`;
      params.push(status);
    }
    
    if (category && category !== "all") {
      sql += ` AND t.category = ?`;
      params.push(category);
    }
    
    if (priority && priority !== "all") {
      sql += ` AND t.priority = ?`;
      params.push(priority);
    }
    
    if (assigned === "me") {
      sql += ` AND t.assigned_to = ?`;
      params.push(req.user.uid);
    } else if (assigned === "unassigned") {
      sql += ` AND t.assigned_to IS NULL`;
    }
    
    sql += ` ORDER BY 
      CASE t.priority 
        WHEN 'urgent' THEN 1 
        WHEN 'high' THEN 2 
        WHEN 'medium' THEN 3 
        WHEN 'low' THEN 4 
      END,
      t.created_at DESC`;
    
    const tickets = await all(sql, params);
    res.json({ tickets });
  } catch (err) {
    console.error("[Support] Error fetching staff tickets:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   STAFF: ASSIGN TICKET
------------------------------ */
router.patch("/staff/tickets/:id/assign", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "moderator") {
      return res.status(403).json({ error: "not_authorized" });
    }
    
    const ticketId = parseInt(req.params.id);
    const { user_id } = req.body;
    
    // Verify the user exists and is staff
    if (user_id) {
      const user = await get(
        `SELECT role FROM users WHERE id = ?`,
        [user_id]
      );
      
      if (!user || (user.role !== "admin" && user.role !== "moderator")) {
        return res.status(400).json({ error: "invalid_user" });
      }
    }
    
    await run(
      `UPDATE support_tickets SET assigned_to = ?, updated_at = ? WHERE id = ?`,
      [user_id || null, Date.now(), ticketId]
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error("[Support] Error assigning ticket:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   STAFF: UPDATE TICKET
------------------------------ */
router.patch("/staff/tickets/:id", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "moderator") {
      return res.status(403).json({ error: "not_authorized" });
    }
    
    const ticketId = parseInt(req.params.id);
    const { status, priority, category } = req.body;
    
    const updates = [];
    const params = [];
    
    if (status) {
      updates.push("status = ?");
      params.push(status);
      
      if (status === "closed") {
        updates.push("closed_at = ?");
        params.push(Date.now());
      }
    }
    
    if (priority) {
      updates.push("priority = ?");
      params.push(priority);
    }
    
    if (category) {
      updates.push("category = ?");
      params.push(category);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: "no_updates" });
    }
    
    updates.push("updated_at = ?");
    params.push(Date.now());
    params.push(ticketId);
    
    await run(
      `UPDATE support_tickets SET ${updates.join(", ")} WHERE id = ?`,
      params
    );
    
    res.json({ success: true });
  } catch (err) {
    console.error("[Support] Error updating ticket:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

/* -----------------------------
   GET SUPPORT STATS
------------------------------ */
router.get("/stats", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "moderator") {
      return res.status(403).json({ error: "not_authorized" });
    }
    
    const totalOpen = await get(
      `SELECT COUNT(*) as count FROM support_tickets WHERE status != 'closed'`
    );
    
    const totalClosed = await get(
      `SELECT COUNT(*) as count FROM support_tickets WHERE status = 'closed'`
    );
    
    const byPriority = await all(
      `SELECT priority, COUNT(*) as count FROM support_tickets WHERE status != 'closed' GROUP BY priority`
    );
    
    const byCategory = await all(
      `SELECT category, COUNT(*) as count FROM support_tickets WHERE status != 'closed' GROUP BY category`
    );
    
    const avgResponseTime = await get(
      `SELECT AVG(
        (SELECT MIN(created_at) FROM support_messages WHERE ticket_id = t.id AND is_staff_reply = 1) - t.created_at
      ) as avg_time
      FROM support_tickets t
      WHERE status = 'closed' AND closed_at > ?`,
      [Date.now() - 30 * 24 * 60 * 60 * 1000] // Last 30 days
    );
    
    res.json({
      total_open: totalOpen.count,
      total_closed: totalClosed.count,
      by_priority: byPriority,
      by_category: byCategory,
      avg_response_time_ms: avgResponseTime.avg_time || 0
    });
  } catch (err) {
    console.error("[Support] Error fetching stats:", err);
    res.status(500).json({ error: "internal_error" });
  }
});

export { router as supportRouter };
