import { Router, Request, Response } from "express";
import { createUserWithPassword, getUserByEmail } from "../services/users.js";
import { hashPassword, comparePassword, validatePassword, validateEmail } from "../utils/password.js";
import { checkSeatLimitAtLogin } from "../middleware/seatLimitCheck.js";

export function emailAuthRouter() {
  const r = Router();

  // POST /api/auth/signup - Create new user with email+password
  r.post("/signup", async (req: Request, res: Response) => {
    try {
      const { email, password, name } = req.body;

      // Validate email format
      const emailValidation = validateEmail(email);
      if (!emailValidation.valid) {
        return res.status(400).json({ error: emailValidation.error });
      }

      // Validate password strength
      const passwordValidation = validatePassword(password);
      if (!passwordValidation.valid) {
        return res.status(400).json({ error: passwordValidation.error });
      }

      // Validate name
      if (!name || name.trim().length === 0) {
        return res.status(400).json({ error: "Name is required" });
      }

      // Check if user already exists
      const existingUser = getUserByEmail(email);
      if (existingUser) {
        return res.status(409).json({ error: "User with this email already exists" });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user
      const newUser = createUserWithPassword({
        email: email.toLowerCase().trim(),
        name: name.trim(),
        passwordHash
      });

      // Create session (same as Google OAuth)
      (req.session as any).user = {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        credits: newUser.credits
      };

      // Return user (without password fields)
      res.status(201).json({
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        credits: newUser.credits
      });

    } catch (error) {
      console.error("[emailAuth] Signup error:", error);
      res.status(500).json({ error: "Failed to create account" });
    }
  });

  // POST /api/auth/login - Login with email+password
  r.post("/login", async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      // Validate inputs
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      // Find user by email
      const user = getUserByEmail(email.toLowerCase().trim());
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Check if this is an OAuth-only user (no password set)
      if (!user.passwordHash) {
        return res.status(400).json({
          error: "This account uses Google sign-in. Please log in with Google.",
          isOAuthOnly: true
        });
      }

      // Verify password
      const isValidPassword = await comparePassword(password, user.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // ENFORCE SEAT LIMIT AT LOGIN
      const seatCheck = await checkSeatLimitAtLogin(user);
      if (!seatCheck.allowed) {
        return res.status(403).json({
          error: "Agency seat limit exceeded",
          message: seatCheck.error,
          code: "SEAT_LIMIT_EXCEEDED"
        });
      }

      // Create session (same as Google OAuth)
      (req.session as any).user = {
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits
      };

      // Return user (without password fields)
      res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        credits: user.credits
      });

    } catch (error) {
      console.error("[emailAuth] Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  return r;
}
