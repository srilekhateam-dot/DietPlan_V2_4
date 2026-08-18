// /**
//  * ═══════════════════════════════════════════════════════════════
//  *  firebase.js  —  NutriPlan Firebase Integration Module
//  *  All Firebase Auth + Firestore logic lives here.
//  *  Imported by onboarding.html as a ES module script.
//  * ═══════════════════════════════════════════════════════════════
//  *
//  *  EXPORTS (attached to window for non-module scripts to call):
//  *    window.NP_FB = {
//  *      auth, db,
//  *      createAccount(), loginUser(), logoutUser(),
//  *      saveAssessmentData(), loadAssessmentData(),
//  *      autoSaveAssessment(), stopAutoSave()
//  *    }
//  *
//  *  AUTH FLOW:
//  *    1. On page load  → onAuthStateChanged fires
//  *       • Signed in   → show avatar, preload saved data into form
//  *       • Signed out  → show "Sign In" button, try restoring localStorage draft
//  *
//  *    2. On form submit (submitForm) in onboarding.html:
//  *       • If user NOT signed in → openAccountModal() is called
//  *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
//  *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
//  *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
//  *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
//  *       • If user IS signed in  → saveAssessmentData() called immediately
//  *
//  *  SAVING FLOW (saveAssessmentData):
//  *    Reads all form fields + calculated metrics into one flat object.
//  *    Writes to THREE Firestore paths under the authenticated user's UID:
//  *      • users/{uid}/profile          — name, email, phone, basic info
//  *      • users/{uid}/assessment/current — all assessment fields + calculated data
//  *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
//  *    Also mirrors full submission to the legacy "submissions/{userId}" path
//  *    so admin tools continue to work unchanged.
//  *
//  *  LOADING FLOW (loadAssessmentData):
//  *    Reads users/{uid}/assessment/current from Firestore.
//  *    Restores every form field, chip selections, MSDD dropdowns, etc.
//  *    Falls back to localStorage draft if Firestore has no saved data.
//  *
//  *  AUTO-SAVE LOGIC:
//  *    When a user is signed in, we start a 5-second debounce interval.
//  *    Any form interaction resets the timer. After 5 s of inactivity the
//  *    draft is persisted to Firestore (users/{uid}/assessment/current).
//  *    Auto-save is stopped when the modal is open or the form is submitted.
//  *
//  *  LOCALSTORAGE BACKUP:
//  *    When a user skips account creation OR is not signed in, the draft is
//  *    written to localStorage under "nutriplan_ls_draft".
//  *    On page reload, loadAssessmentData() restores it if no Firestore data
//  *    is available.
//  */

// // ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
// import { initializeApp }
//   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// import {
//   getAuth,
//   createUserWithEmailAndPassword,
//   signInWithEmailAndPassword,
//   signOut as fbSignOut,
//   onAuthStateChanged,
//   sendPasswordResetEmail,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// import {
//   getFirestore,
//   doc,
//   getDoc,
//   setDoc,
//   collection,
//   serverTimestamp,
//   onSnapshot,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// // ── Firebase project config ──────────────────────────────────────────────────
// const firebaseConfig = {
//   apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
//   authDomain:        "nutriplan-65582.firebaseapp.com",
//   projectId:         "nutriplan-65582",
//   storageBucket:     "nutriplan-65582.firebasestorage.app",
//   messagingSenderId: "851509980462",
//   appId:             "1:851509980462:web:b18af741addba334ca1ebf",
//   measurementId:     "G-2XZZ9YW5FJ",
// };

// // ── Initialise Firebase ───────────────────────────────────────────────────────
// const app  = initializeApp(firebaseConfig);
// const auth = getAuth(app);
// const db   = getFirestore(app);

// // Expose auth + db to window so legacy inline scripts can reference them
// window._fbAuth = auth;
// window._fbDb   = db;


// // ════════════════════════════════════════════════════════════════════════════
// //  HELPERS
// // ════════════════════════════════════════════════════════════════════════════

// /** Map Firebase auth error codes to user-friendly messages. */
// function friendlyAuthError(code) {
//   const map = {
//     "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
//     "auth/invalid-email":          "Please enter a valid email address.",
//     "auth/weak-password":          "Password is too weak — minimum 6 characters.",
//     "auth/user-not-found":         "No account found with that email.",
//     "auth/wrong-password":         "Incorrect password. Please try again.",
//     "auth/invalid-credential":     "Incorrect email or password.",
//     "auth/network-request-failed": "Network error — please check your connection and try again.",
//     "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
//   };
//   return map[code] || "Authentication error. Please try again.";
// }

// /** Check whether a Firestore "restrictedUsers" doc exists for this email. */
// async function checkUserNotRestricted(email) {
//   const docId = email.toLowerCase().replace(/[@.]/g, "_");
//   try {
//     const snap = await getDoc(doc(db, "restrictedUsers", docId));
//     if (snap.exists()) return false;
//   } catch (_) {}
//   return true;
// }

// /** Check whether the global settings allow new registrations. */
// async function checkRegistrationOpen() {
//   try {
//     const snap = await getDoc(doc(db, "settings", "global"));
//     if (snap.exists() && snap.data().registrationClosed === true) return false;
//   } catch (err) {
//     // permission-denied means the rules block unauthenticated reads on settings/global
//     // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
//     if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
//   }
//   return true;
// }

// /** Safely read a DOM element value. */
// const gv = (id) => document.getElementById(id)?.value ?? "";

// /** Read all active chip texts from a CSS selector. */
// const activeChips = (sel) =>
//   [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// // ════════════════════════════════════════════════════════════════════════════
// //  COLLECT FORM DATA
// //  Reads every field on the assessment form into a plain JS object.
// //  Called by saveAssessmentData() and the legacy submitForm().
// // ════════════════════════════════════════════════════════════════════════════

// function collectFormData() {
//   // Safe field reader — returns "-" if element missing or value empty
//   const fv = (id) => { const el = document.getElementById(id); return (el?.value || "").trim() || "-"; };
//   const fb = (id) => { const el = document.getElementById(id); return el ? (el.checked ? "Yes" : "No") : "-"; };
//   const fc = (sel) => { const r = [...document.querySelectorAll(sel + ".active")].map(c => c.textContent.trim()); return r.length ? r.join(", ") : "-"; };
//   const fm = (key) => { const r = ((window.msddState || {})[key] || []); return r.length ? r.join(", ") : "-"; };

//   const d   = window._lastCalcData || {};
//   const ht  = d.ht  || 0;
//   const wt  = d.wt  || 0;
//   const bmiNum = ht > 0 ? wt / ((ht / 100) ** 2) : 0;
//   const bmiCat = bmiNum < 18.5 ? "Underweight" : bmiNum < 25 ? "Normal" : bmiNum < 30 ? "Overweight" : "Obese";

//   const waistVal = parseFloat(document.getElementById("inp-waist")?.value) || 0;
//   const neckVal  = parseFloat(document.getElementById("inp-neck")?.value)  || 0;
//   const hipVal   = parseFloat(document.getElementById("inp-hip")?.value)   || 0;
//   const gender   = document.getElementById("inp-gender")?.value || d.gender || "";

//   // Weekend eating rule
//   const werEnabled    = document.getElementById("wer-yes-btn")?.classList.contains("active") ? "Yes" : "No";
//   const werDays       = [...document.querySelectorAll(".wer-day-chip.active")].map(c => c.dataset.day || c.textContent.trim());
//   const werRule       = [...document.querySelectorAll(".wer-rule-chip.active")].map(c => c.dataset.rule || c.textContent.trim());
//   const werCustom     = (document.getElementById("wer-custom-input")?.value || "").trim();
//   const werRepeatDays = [...document.querySelectorAll(".wer-repeat-chip.active")].map(c => c.textContent.trim());

//   const planForSelf = window._planForSelf !== false;

//   return {
//     // ── IDs & metadata ──
//     timestamp: new Date().toISOString(),

//     // ── Plan context ──
//     plan_for:            planForSelf ? "Self" : "Other",
//     plan_other_name:     planForSelf ? "-" : (document.getElementById("plan-other-name")?.value || "-").trim(),
//     plan_other_relation: planForSelf ? "-" : (document.getElementById("plan-other-relation")?.value || "-").trim(),

//     // ── Personal details ──
//     name:   (document.getElementById("inp-name")?.value || "").trim() || "-",
//     age:    fv("inp-age"),
//     gender: gender || "-",
//     phone:  fv("inp-phone"),
//     email:  fv("inp-email"),

//     // ── Body measurements ──
//     height:           ht ? String(ht) : "-",
//     height_unit:      (document.querySelector(".hcb-tab.active")?.textContent || "-").trim(),
//     weight:           wt ? String(wt) : "-",
//     waist:            waistVal ? String(waistVal) : "-",
//     neck:             neckVal  ? String(neckVal)  : "-",
//     hip:              (gender === "Female" && hipVal) ? String(hipVal) : (gender === "Female" ? "-" : "N/A"),
//     pregnancy_status: fv("inp-preg"),
//     // Save the human-readable label (e.g. "Sedentary — Little or no exercise…")
//     // rather than the raw factor number so admin sees meaningful text.
//     activity_level: (() => {
//       const sel = document.getElementById("inp-activity");
//       if (!sel || !sel.value) return "-";
//       const opt = sel.options[sel.selectedIndex];
//       return opt ? opt.text.trim() : sel.value;
//     })(),
//     activity_factor: fv("inp-activity"),  // keep the numeric factor for calculations

//     // ── Calculated metrics ──
//     bmi:                  bmiNum > 0 ? bmiNum.toFixed(1) : "-",
//     bmi_category:         bmiNum > 0 ? bmiCat : "-",
//     body_fat:             "-",  // computed from measurements only at submit time
//     ideal_weight:         d.idealWeight ? d.idealWeight.toFixed(1) : "-",
//     current_weight:       wt ? String(wt) : "-",
//     weight_to_goal:       d.kgDiff ? d.kgDiff.toFixed(1) + " kg" : "-",
//     goal_direction:       d.direction || "-",
//     bmr:                  d.bmr ? String(Math.round(d.bmr)) : "-",
//     maintenance_calories: d.maintenance ? String(d.maintenance) : "-",
//     goal_calories: (() => {
//       if (!d.maintenance) return "-";
//       const rate = window._currentGoalRate || 0.5;
//       let gc = d.direction === "loss" ? d.maintenance - Math.round(rate * 1000)
//              : d.direction === "gain" ? d.maintenance + Math.round(rate * 600)
//              : d.maintenance;
//       return String(Math.max(1000, gc));
//     })(),
//     goal_rate_kg_per_week: String(window._currentGoalRate || 0.5),
//     timeline_days: (() => {
//       if (!d.kgDiff || d.direction === "maintain") return "-";
//       return String(Math.round((d.kgDiff / (window._currentGoalRate || 0.5)) * 7));
//     })(),
//     after_goal_calories: (() => {
//       if (!d.idealWeight || !ht || !d.age) return "-";
//       const afterBmr = gender === "Female"
//         ? (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) - 161
//         : (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) + 5;
//       return String(Math.round(afterBmr * (parseFloat(d.activity) || 1.2)));
//     })(),

//     // ── Health ──
//     health_conditions: [...(window.selectedConditions ?? new Set())].join(", ") || "-",
//     allergies:         fv("inp-allergies"),

//     // ── Diet preferences ──
//     diet_preference: fv("inp-diet"),
//     num_curries:     fv("inp-curries"),
//     meal_types:      fc("#meal-types .chip"),
//     eating_window:   fv("eat-window-val"),

//     // ── Weekend eating rule ──
//     weekend_eating_rule:        werEnabled,
//     weekend_eating_days:        werDays.length    ? werDays.join(", ")    : "-",
//     weekend_eating_rule_type:   werRule.length    ? werRule.join(", ")    : "-",
//     weekend_eating_custom_rule: werCustom         || "-",
//     weekend_eating_repeat_days: werRepeatDays.length ? werRepeatDays.join(", ") : "-",

//     // ── Food preferences — MSDD dropdowns ──
//     morning_drinks:  fm("msdd-drinks"),
//     nuts:            fm("msdd-nuts"),
//     seeds:           fm("msdd-seeds"),
//     fruits:          fm("msdd-fruits"),
//     vegetables:      fm("msdd-veggies"),
//     sprouts:         fm("msdd-sprouts"),
//     milkshakes:      fm("msdd-milkshakes"),
//     smoothies:       fm("msdd-smoothies"),
//     porridge_malt:   fm("msdd-porridge"),
//     breakfast:       fm("msdd-breakfast"),
//     chutney:         fm("msdd-chutney"),
//     powders_ghee:    fm("msdd-powders"),
//     non_veg:         fm("msdd-nonveg"),
//     rice:            fm("msdd-rice"),
//     millets_grains:  fm("msdd-millets"),

//     // ── Symptoms & final notes ──
//     symptoms:         fc("#symptoms-group .chip"),
//     food_dislikes:    fv("inp-dislikes"),
//     comments:         fv("inp-comments"),
//     whatsapp_consent: fb("consent-wa"),
//   };
// }



// // ════════════════════════════════════════════════════════════════════════════
// //  saveAssessmentData(uid)
// //  Writes all assessment fields + metadata to Firestore under the user's UID.
// //
// //  Firestore structure:
// //    users/{uid}/profile          — name, email, phone
// //    users/{uid}/assessment/current — full assessment snapshot
// //    users/{uid}/progress         — goals, BMI, body fat, timestamps
// //
// //  Also writes to legacy submissions/{submissionId} for admin compatibility.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveAssessmentData(uid, submissionId) {
//   if (!uid) {
//     console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
//     return;
//   }

//   const data = collectFormData();
//   const now  = serverTimestamp();

//   try {
//     // 1. Profile document (quick lookup fields)
//     await setDoc(
//       doc(db, "users", uid, "profile", "info"),
//       {
//         name:      data.name,
//         email:     data.email || auth.currentUser?.email || "",
//         phone:     data.phone,
//         updatedAt: now,
//       },
//       { merge: true }
//     );

//     // 2. Full assessment snapshot (overwrites on each save)
//     await setDoc(
//       doc(db, "users", uid, "assessment", "current"),
//       {
//         ...data,
//         uid,
//         submissionId: submissionId || "",
//         savedAt: now,
//       }
//     );

//     // 3. Progress / goal metrics document
//     await setDoc(
//       doc(db, "users", uid, "progress", "latest"),
//       {
//         bmi:              data.bmi,
//         bmi_category:     data.bmi_category,
//         body_fat:         data.body_fat,
//         ideal_weight:     data.ideal_weight,
//         goal_direction:   data.goal_direction,
//         goal_calories:    data.goal_calories,
//         maintenance_calories: data.maintenance_calories,
//         bmr:              data.bmr,
//         recordedAt:       now,
//       },
//       { merge: true }
//     );

//     console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
//   } catch (err) {
//     console.error("[NP Firebase] saveAssessmentData error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loadAssessmentData(uid)
// //  Reads users/{uid}/assessment/current and restores the form.
// //  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// // ════════════════════════════════════════════════════════════════════════════

// async function loadAssessmentData(uid) {
//   let data = null;

//   if (uid) {
//     try {
//       const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
//       if (snap.exists()) {
//         data = snap.data();
//         console.info("[NP Firebase] Assessment loaded from Firestore.");
//       }
//     } catch (err) {
//       console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
//     }
//   }

//   // Fall back to localStorage draft
//   if (!data) {
//     try {
//       const raw = localStorage.getItem("nutriplan_ls_draft");
//       if (raw) data = JSON.parse(raw);
//       if (data) console.info("[NP Firebase] Assessment loaded from localStorage draft.");
//     } catch (_) {}
//   }

//   if (!data) return; // Nothing to restore

//   // ── Restore simple text/number/select fields ──
//   const set = (id, val) => {
//     const el = document.getElementById(id);
//     if (el && val !== undefined && val !== null && val !== "") el.value = val;
//   };

//   set("inp-name",     data.name);
//   set("inp-age",      data.age);
//   set("inp-phone",    data.phone);
//   set("inp-email",    data.email);
//   set("inp-allergies",data.allergies);
//   set("inp-dislikes", data.food_dislikes);
//   set("inp-comments", data.comments);
//   set("inp-curries",  data.num_curries);
//   set("eat-window-val", data.eating_window);

//   if (data.height) {
//     set("inp-height",    data.height);
//     set("inp-height-cm", Math.round(data.height));
//   }
//   set("inp-weight",   data.weight);
//   set("inp-preg",     data.pregnancy_status);

//   // Measurements
//   ["waist", "neck", "hip"].forEach((m) => {
//     const val = data[m];
//     if (!val) return;
//     const raw = document.getElementById(m + "-raw-input");
//     const hid = document.getElementById("inp-" + m);
//     if (raw) raw.value = val;
//     if (hid) hid.value = val;
//   });

//   // Gender (triggers female row visibility)
//   if (data.gender) {
//     set("inp-gender", data.gender);
//     const femRow = document.getElementById("female-extra-row");
//     if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
//   }

//   // activity_factor stores the numeric select value; activity_level stores the label (new). Support both.
//   if (data.activity_factor && data.activity_factor !== "-") set("inp-activity", data.activity_factor);
//   else if (data.activity_level && /^\d/.test(data.activity_level)) set("inp-activity", data.activity_level); // legacy fallback
//   if (data.diet_preference) set("inp-diet",     data.diet_preference);
//   if (document.getElementById("consent-wa"))
//     document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

//   // ── Restore chip selections ──
//   const restoreChips = (selector, csvString) => {
//     if (!csvString) return;
//     const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
//     document.querySelectorAll(selector).forEach((chip) => {
//       if (active.includes(chip.textContent.trim())) chip.classList.add("active");
//     });
//   };
//   restoreChips("#meal-types .chip",      data.meal_types);
//   restoreChips("#symptoms-group .chip",  data.symptoms);

//   // Eating time chip
//   if (data.eating_window) {
//     document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
//       if (tc.dataset.value === data.eating_window) tc.classList.add("active");
//     });
//   }

//   // ── Restore Weekend Eating Rule ──
//   if (data.weekend_eating_rule === "Yes") {
//     const yesBtn = document.getElementById("wer-yes-btn");
//     const noBtn  = document.getElementById("wer-no-btn");
//     if (yesBtn) { yesBtn.classList.add("active"); }
//     if (noBtn)  { noBtn.classList.remove("active"); }
//     // Show the WER panel if it exists
//     const werPanel = document.getElementById("wer-panel") || document.querySelector(".wer-options");
//     if (werPanel) werPanel.style.display = "block";
//   }
//   // Restore selected WER days
//   if (data.weekend_eating_days && data.weekend_eating_days !== "-") {
//     const days = data.weekend_eating_days.split(",").map(v => v.trim()).filter(Boolean);
//     document.querySelectorAll(".wer-day-chip").forEach(chip => {
//       const d2 = chip.dataset.day || chip.textContent.trim();
//       if (days.includes(d2)) chip.classList.add("active");
//     });
//   }
//   // Restore WER rule chips
//   if (data.weekend_eating_rule_type && data.weekend_eating_rule_type !== "-") {
//     const rules = data.weekend_eating_rule_type.split(",").map(v => v.trim()).filter(Boolean);
//     document.querySelectorAll(".wer-rule-chip").forEach(chip => {
//       if (rules.includes(chip.dataset.rule || chip.textContent.trim())) chip.classList.add("active");
//     });
//   }
//   // Restore WER custom text
//   if (data.weekend_eating_custom_rule && data.weekend_eating_custom_rule !== "-") {
//     const werCustom = document.getElementById("wer-custom-input");
//     if (werCustom) werCustom.value = data.weekend_eating_custom_rule;
//   }
//   // Restore WER repeat-days chips
//   if (data.weekend_eating_repeat_days && data.weekend_eating_repeat_days !== "-") {
//     const repeatDays = data.weekend_eating_repeat_days.split(",").map(v => v.trim()).filter(Boolean);
//     document.querySelectorAll(".wer-repeat-chip").forEach(chip => {
//       if (repeatDays.includes(chip.textContent.trim())) chip.classList.add("active");
//     });
//     // Show repeat row if chips are active
//     const repeatRow = document.getElementById("wer-repeat-row");
//     if (repeatRow) repeatRow.style.display = "flex";
//   }

//   // ── Restore MSDD dropdowns ──
//   const msddMap = {
//     "msdd-drinks":    data.morning_drinks,
//     "msdd-fruits":    data.fruits,
//     "msdd-veggies":   data.vegetables,
//     "msdd-sprouts":   data.sprouts,
//     "msdd-milkshakes":data.milkshakes,
//     "msdd-smoothies": data.smoothies,
//     "msdd-porridge":  data.porridge_malt,
//     "msdd-breakfast": data.breakfast,
//     "msdd-chutney":   data.chutney,
//     "msdd-powders":   data.powders_ghee,
//     "msdd-nonveg":    data.non_veg,
//     "msdd-rice":      data.rice,
//     "msdd-millets":   data.millets_grains,
//   };
//   Object.entries(msddMap).forEach(([id, csv]) => {
//     if (!csv) return;
//     csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.msddChange === "function") window.msddChange(id);
//   });

//   // Nuts + seeds (stored combined in "nuts_seeds")
//   if (data.nuts_seeds) {
//     data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       ["msdd-nuts", "msdd-seeds"].forEach((id) => {
//         const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//         if (cb) cb.checked = true;
//       });
//     });
//     if (typeof window.msddChange === "function") {
//       window.msddChange("msdd-nuts");
//       window.msddChange("msdd-seeds");
//     }
//   }

//   // ── Restore health conditions ──
//   if (data.health_conditions) {
//     const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
//     conds.forEach((v) => {
//       if (window.selectedConditions) window.selectedConditions.add(v);
//       const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.renderTags === "function") window.renderTags();
//   }

//   // Open hidden sections that were visible
//   ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
//     setTimeout(() => {
//       const el = document.getElementById(id);
//       if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
//     }, i * 100);
//   });

//   console.info("[NP Firebase] Form restored from saved data.");
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveLocalStorageDraft()
// //  Writes a lightweight draft to localStorage for users who skip sign-in.
// //  Called by autoSaveAssessment() when not signed in.
// // ════════════════════════════════════════════════════════════════════════════

// function saveLocalStorageDraft() {
//   try {
//     const data = collectFormData();
//     localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
//   } catch (err) {
//     console.warn("[NP Firebase] localStorage backup error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  AUTO-SAVE LOGIC
// //  When signed in: debounce-saves to Firestore after 5 s of inactivity.
// //  When not signed in: saves to localStorage after 3 s of inactivity.
// //  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// // ════════════════════════════════════════════════════════════════════════════

// let _autoSaveTimer   = null;
// let _autoSaveEnabled = false;

// /** Trigger a debounced auto-save. Call this from form input listeners. */
// function scheduleAutoSave() {
//   if (!_autoSaveEnabled) return;
//   clearTimeout(_autoSaveTimer);

//   const user = auth.currentUser;
//   const delay = user ? 5000 : 3000;

//   _autoSaveTimer = setTimeout(async () => {
//     if (auth.currentUser) {
//       // Auto-save to Firestore
//       await saveAssessmentData(auth.currentUser.uid);
//     } else {
//       // Auto-save to localStorage
//       saveLocalStorageDraft();
//     }
//   }, delay);
// }

// /** Start auto-save listeners on all form inputs. */
// function autoSaveAssessment() {
//   _autoSaveEnabled = true;

//   const attach = () => {
//     document.querySelectorAll("input, select, textarea").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("input",  scheduleAutoSave);
//         el.addEventListener("change", scheduleAutoSave);
//       }
//     });
//     // Chips and toggle buttons
//     document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
//       }
//     });
//   };

//   attach();
//   // Re-attach after any dynamically rendered chips
//   new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

//   console.info("[NP Firebase] Auto-save enabled.");
// }

// /** Pause auto-save (e.g. while a modal is open or after final submission). */
// function stopAutoSave() {
//   _autoSaveEnabled = false;
//   clearTimeout(_autoSaveTimer);
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  createAccount(email, password)
// //  Creates a new Firebase Auth user and saves assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function createAccount(email, password) {
//   // Validate inputs
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (password.length < 6)
//     return { ok: false, error: "Password must be at least 6 characters." };

//   // Check server-side gates
//   const regOpen = await checkRegistrationOpen();
//   if (!regOpen)
//     return { ok: false, error: "New registrations are currently closed." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This email address is not allowed to register." };

//   try {
//     // Create Firebase Auth account
//     const cred = await createUserWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Persist account metadata
//     await setDoc(
//       doc(db, "accounts", uid),
//       { email, createdAt: serverTimestamp() }
//     );

//     // Save all pending assessment data to Firestore
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     // Store session hints
//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     // Remove localStorage draft — it's now in Firestore
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Account created:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] createAccount error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loginUser(email, password)
// //  Signs the user in and saves any pending assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function loginUser(email, password) {
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (!password)
//     return { ok: false, error: "Enter your password." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This account has been restricted." };

//   try {
//     const cred = await signInWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Save pending assessment data
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Signed in:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] loginUser error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  logoutUser()
// //  Signs out of Firebase Auth and clears session hints.
// // ════════════════════════════════════════════════════════════════════════════

// async function logoutUser() {
//   try {
//     stopAutoSave();
//     await fbSignOut(auth);

//     localStorage.removeItem("nutriplan_uid");
//     localStorage.removeItem("nutriplan_email");
//     localStorage.removeItem("np_auth");

//     console.info("[NP Firebase] Signed out.");
//     return { ok: true };
//   } catch (err) {
//     console.error("[NP Firebase] logoutUser error:", err.message);
//     return { ok: false, error: err.message };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
// //  Mirrors a submission to the "submissions" collection used by admin tools.
// //  Preserved 100% from the original firebase module so nothing breaks.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
//   try {
//     const isEdit = !!(formData._editUid);
//     let resolvedUid = accountUid || null;
//     if (isEdit) {
//       try {
//         const snap = await getDoc(doc(db, "submissions", formData.userId));
//         if (snap.exists() && snap.data().accountUid)
//           resolvedUid = snap.data().accountUid;
//       } catch (_) {}
//     }
//     const entry = {
//       ...formData,
//       accountUid: resolvedUid,
//       forSelf:    forSelf !== false,
//       relName:    relName  || "",
//       relation:   relation || "",
//       ...(isEdit
//         ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
//         : { createdAt: serverTimestamp() }),
//     };
//     delete entry._editUid;
//     await setDoc(
//       doc(db, "submissions", formData.userId),
//       entry,
//       isEdit ? { merge: false } : {}
//     );
//     if (resolvedUid) {
//       await setDoc(
//         doc(db, "accounts", resolvedUid, "profiles", formData.userId),
//         {
//           userId:    formData.userId,
//           name:      formData.name,
//           forSelf:   entry.forSelf,
//           relName:   entry.relName,
//           relation:  entry.relation,
//           timestamp: formData.timestamp,
//         }
//       );
//     }
//   } catch (err) {
//     console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
//   }
// }

// // Expose legacy function under original name so existing inline code still works
// window.saveToFirestore = saveToFirestoreLegacy;


// // ════════════════════════════════════════════════════════════════════════════
// //  onAuthStateChanged — central auth observer
// //  • Signed in  → show avatar with initials, preload saved form data
// //  • Signed out → show "Sign In" button, try loading localStorage draft
// // ════════════════════════════════════════════════════════════════════════════

// onAuthStateChanged(auth, async (user) => {
//   const profileBtn = document.getElementById("nav-profile-btn");
//   const signinBtn  = document.getElementById("nav-signin-btn");
//   const step0Block = document.getElementById("step0-block");

//   if (user) {
//     // Restriction check
//     const allowed = await checkUserNotRestricted(user.email || "");
//     if (!allowed) {
//       await fbSignOut(auth);
//       localStorage.removeItem("np_auth");
//       if (profileBtn) profileBtn.classList.remove("show");
//       if (signinBtn)  signinBtn.classList.add("show");
//       return;
//     }

//     // Show avatar with email initial
//     if (profileBtn) {
//       const initial = (user.email || "U")[0].toUpperCase();
//       profileBtn.textContent = initial;
//       profileBtn.classList.add("show");
//     }
//     if (signinBtn) signinBtn.classList.remove("show");

//     // Show auth-gated nav links (Dietplan, Comments, Messages) on any page
//     localStorage.setItem("np_auth", "signed-in");
//     if (typeof window._updateAuthNavLinks === "function") window._updateAuthNavLinks(true);

//     // Start auto-save now that the user is authenticated
//     autoSaveAssessment();

//     // Show step0 block on the assessment page when user is signed in
//     if (step0Block) step0Block.style.display = 'block';

//     // Pre-load any previously saved assessment data into the form
//     // Skip if:
//     //   1. a session draft is already present (avoid overwriting fresh session), OR
//     //   2. the user explicitly clicked "Back to Assessment Form" (nutriplan_back flag), OR
//     //   3. a submitted assessment exists in sessionStorage (loadExistingAssessment will show
//     //      the dashboard instead — no need to populate the hidden form)
//     const hasSessionDraft      = !!sessionStorage.getItem("nutriplan_draft");
//     const wentBackToForm       = sessionStorage.getItem("nutriplan_back") === "1";
//     const hasSubmittedAssessment = !!sessionStorage.getItem("nutriplan_assessment");
//     if (!hasSessionDraft && !wentBackToForm && !hasSubmittedAssessment) {
//       await loadAssessmentData(user.uid);
//     }

//   } else {
//     // Not signed in
//     localStorage.removeItem("np_auth");
//     if (profileBtn) profileBtn.classList.remove("show");
//     if (signinBtn)  signinBtn.classList.add("show");
//     if (step0Block) step0Block.style.display = "none";
//     // Hide auth-gated nav links
//     if (typeof window._updateAuthNavLinks === "function") window._updateAuthNavLinks(false);

//     // Still start auto-save so localStorage draft stays fresh
//     autoSaveAssessment();
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
// //  Re-uses the exact same logic from the original firebase module.
// // ════════════════════════════════════════════════════════════════════════════

// window._regClosed = true;

// onSnapshot(doc(db, "settings", "global"), (snap) => {
//   if (snap.exists()) {
//     const data        = snap.data();
//     const formClosed  = !!data.formSubmissionClosed;
//     const regClosed   = !!data.registrationClosed;

//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(formClosed);

//     window._regClosed = regClosed;

//     // Keep modal tabs in sync if modal is open
//     const modal = document.getElementById("accountModal");
//     if (modal && modal.style.display === "flex") {
//       if (regClosed) {
//         if (typeof window.applyModalRegClosedState === "function")
//           window.applyModalRegClosedState();
//       } else {
//         ["create", "login"].forEach((t) => {
//           const tab = document.getElementById("tab-" + t);
//           if (tab) {
//             tab.classList.remove("active");
//             tab.style.opacity = "";
//             tab.style.cursor  = "";
//             tab.style.pointerEvents = "";
//             tab.title = "";
//           }
//         });
//         document.getElementById("tab-create")?.classList.add("active");
//         const authCreate = document.getElementById("auth-create");
//         const authLogin  = document.getElementById("auth-login");
//         if (authCreate) authCreate.style.display = "block";
//         if (authLogin)  authLogin.style.display  = "none";
//         const notice = document.getElementById("modal-reg-closed-notice");
//         if (notice) notice.style.display = "none";
//       }
//     }
//   } else {
//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(false);
//     window._regClosed = false;
//   }
// }, (err) => {
//   // "Missing or insufficient permissions" is expected when the user is signed out
//   // and Firestore rules require auth for this document.
//   // Fix: set `allow read: if true` on settings/global in your Firestore rules.
//   // We only log unexpected errors (not permission denials).
//   if (err.code !== 'permission-denied') {
//     console.warn("[NP Firebase] settings read error:", err.code, err.message);
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD RESET
// //  Exposed globally so the existing forgotModal can call it.
// // ════════════════════════════════════════════════════════════════════════════

// window.doResetPassword = async function () {
//   const email = document.getElementById("fp-email")?.value?.trim();
//   const errEl = document.getElementById("fp-err");
//   const sucEl = document.getElementById("fp-suc");
//   if (errEl) errEl.style.display = "none";
//   if (sucEl) sucEl.style.display = "none";

//   if (!email || !/\S+@\S+\.\S+/.test(email)) {
//     if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
//     return;
//   }
//   try {
//     await sendPasswordResetEmail(auth, email);
//     if (sucEl) {
//       sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
//       sucEl.style.display = "block";
//     }
//     setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
//   } catch (err) {
//     if (errEl) {
//       errEl.textContent = err.code === "auth/user-not-found"
//         ? "No account found with this email."
//         : friendlyAuthError(err.code);
//       errEl.style.display = "block";
//     }
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
// //  These override the window.createAccount and window.signInExisting
// //  originally defined inline in onboarding.html.
// // ════════════════════════════════════════════════════════════════════════════

// window.createAccount = async function () {
//   const errEl = document.getElementById("acct-err");
//   if (errEl) errEl.style.display = "none";

//   if (window._regClosed) {
//     if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }

//   const email = document.getElementById("acct-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("acct-pass")?.value  ?? "";
//   const pass2 = document.getElementById("acct-pass2")?.value ?? "";

//   if (pass !== pass2) {
//     if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
//     return;
//   }

//   // Disable button while working
//   const btn = document.querySelector("#auth-create .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

//   const result = await createAccount(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// window.signInExisting = async function () {
//   const errEl = document.getElementById("login-err");
//   if (errEl) errEl.style.display = "none";

//   const email = document.getElementById("login-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("login-pass")?.value ?? "";

//   const btn = document.querySelector("#auth-login .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

//   const result = await loginUser(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  SIGN OUT (called by avatar dropdown)
// //  Replaces the doSignOut() function defined in the non-module <script>.
// // ════════════════════════════════════════════════════════════════════════════

// window.doSignOut = async function () {
//   const result = await logoutUser();
//   if (result.ok) {
//     document.getElementById("nav-profile-btn")?.classList.remove("show");
//     const signinBtn = document.getElementById("nav-signin-btn");
//     if (signinBtn) signinBtn.classList.add("show");
//     document.getElementById("avatar-dropdown")?.classList.remove("open");
//     window.location.href = "Dietplan.html";
//   } else {
//     localStorage.removeItem("np_auth");
//     window.location.reload();
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  UNREAD MESSAGES CHECK (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// async function checkUnreadMessages(uid) {
//   try {
//     const { collection: col, getDocs: gd, query: q, where: w } =
//       await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
//     const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
//     if (!snap.empty) {
//       const dot = document.getElementById("nav-msg-dot");
//       if (dot) dot.style.display = "inline-block";
//     }
//   } catch (_) {}
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD VISIBILITY TOGGLE
// // ════════════════════════════════════════════════════════════════════════════

// window.togglePw = function (inputId, btn) {
//   const inp = document.getElementById(inputId);
//   if (!inp) return;
//   const isText = inp.type === "text";
//   inp.type  = isText ? "password" : "text";
//   btn.textContent = isText ? "👁" : "🙈";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  ACCOUNT MODAL HELPERS (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// window.proceedToAuth = function () {
//   document.getElementById("acct-step-save").style.display = "none";
//   const user = auth.currentUser;
//   if (user) {
//     (async () => {
//       await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
//       await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
//       if (typeof window.saveLocalProfile === "function")
//         window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
//       const isEdit = !!window._pendingFormData?._editUid;
//       if (typeof window.showAccountDone === "function")
//         window.showAccountDone(
//           "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
//           isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
//         );
//     })();
//   } else {
//     const authStep = document.getElementById("acct-step-auth");
//     if (authStep) authStep.style.display = "block";
//   }
// };

// window.switchAuthTab = function (tab) {
//   if (tab === "create" && window._regClosed) {
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }
//   ["create", "login"].forEach((t) => {
//     document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
//   });
//   const authCreate = document.getElementById("auth-create");
//   const authLogin  = document.getElementById("auth-login");
//   if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
//   if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
// };

// window.skipAccount = function () { window.closeAccountModal(); };
// window.closeAccountModal = function () {
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "none";
//   // Save to localStorage as backup since user skipped sign-in
//   saveLocalStorageDraft();
// };

// window.openAccountModal = function (formData) {
//   window._pendingFormData = formData;
//   window._isForSelf  = window._planForSelf   !== false;
//   window._relName    = window._planOtherName  || "";
//   window._relation   = window._planOtherRelation || "";
//   document.getElementById("acct-step-save").style.display  = "block";
//   document.getElementById("acct-step-auth").style.display  = "none";
//   document.getElementById("acct-step-done").style.display  = "none";
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "flex";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  PUBLIC API — exposed on window.NP_FB for external scripts
// // ════════════════════════════════════════════════════════════════════════════

// window.NP_FB = {
//   auth,
//   db,
//   createAccount,
//   loginUser,
//   logoutUser,
//   saveAssessmentData,
//   loadAssessmentData,
//   autoSaveAssessment,
//   stopAutoSave,
//   saveLocalStorageDraft,
//   collectFormData,
// };

// // Also expose the firebase instances directly (backwards compat)
// window.auth = auth;
// window.db   = db;











// // /**
// //  * ═══════════════════════════════════════════════════════════════
// //  *  firebase.js  —  NutriPlan Firebase Integration Module
// //  *  All Firebase Auth + Firestore logic lives here.
// //  *  Imported by onboarding.html as a ES module script.
// //  * ═══════════════════════════════════════════════════════════════
// //  *
// //  *  EXPORTS (attached to window for non-module scripts to call):
// //  *    window.NP_FB = {
// //  *      auth, db,
// //  *      createAccount(), loginUser(), logoutUser(),
// //  *      saveAssessmentData(), loadAssessmentData(),
// //  *      autoSaveAssessment(), stopAutoSave()
// //  *    }
// //  *
// //  *  AUTH FLOW:
// //  *    1. On page load  → onAuthStateChanged fires
// //  *       • Signed in   → show avatar, preload saved data into form
// //  *       • Signed out  → show "Sign In" button, try restoring localStorage draft
// //  *
// //  *    2. On form submit (submitForm) in onboarding.html:
// //  *       • If user NOT signed in → openAccountModal() is called
// //  *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
// //  *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
// //  *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
// //  *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
// //  *       • If user IS signed in  → saveAssessmentData() called immediately
// //  *
// //  *  SAVING FLOW (saveAssessmentData):
// //  *    Reads all form fields + calculated metrics into one flat object.
// //  *    Writes to THREE Firestore paths under the authenticated user's UID:
// //  *      • users/{uid}/profile          — name, email, phone, basic info
// //  *      • users/{uid}/assessment/current — all assessment fields + calculated data
// //  *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
// //  *    Also mirrors full submission to the legacy "submissions/{userId}" path
// //  *    so admin tools continue to work unchanged.
// //  *
// //  *  LOADING FLOW (loadAssessmentData):
// //  *    Reads users/{uid}/assessment/current from Firestore.
// //  *    Restores every form field, chip selections, MSDD dropdowns, etc.
// //  *    Falls back to localStorage draft if Firestore has no saved data.
// //  *
// //  *  AUTO-SAVE LOGIC:
// //  *    When a user is signed in, we start a 5-second debounce interval.
// //  *    Any form interaction resets the timer. After 5 s of inactivity the
// //  *    draft is persisted to Firestore (users/{uid}/assessment/current).
// //  *    Auto-save is stopped when the modal is open or the form is submitted.
// //  *
// //  *  LOCALSTORAGE BACKUP:
// //  *    When a user skips account creation OR is not signed in, the draft is
// //  *    written to localStorage under "nutriplan_ls_draft".
// //  *    On page reload, loadAssessmentData() restores it if no Firestore data
// //  *    is available.
// //  */

// // // ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
// // import { initializeApp }
// //   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// // import {
// //   getAuth,
// //   createUserWithEmailAndPassword,
// //   signInWithEmailAndPassword,
// //   signOut as fbSignOut,
// //   onAuthStateChanged,
// //   sendPasswordResetEmail,
// // } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// // import {
// //   getFirestore,
// //   doc,
// //   getDoc,
// //   setDoc,
// //   collection,
// //   serverTimestamp,
// //   onSnapshot,
// // } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// // // ── Firebase project config ──────────────────────────────────────────────────
// // const firebaseConfig = {
// //   apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
// //   authDomain:        "nutriplan-65582.firebaseapp.com",
// //   projectId:         "nutriplan-65582",
// //   storageBucket:     "nutriplan-65582.firebasestorage.app",
// //   messagingSenderId: "851509980462",
// //   appId:             "1:851509980462:web:b18af741addba334ca1ebf",
// //   measurementId:     "G-2XZZ9YW5FJ",
// // };

// // // ── Initialise Firebase ───────────────────────────────────────────────────────
// // const app  = initializeApp(firebaseConfig);
// // const auth = getAuth(app);
// // const db   = getFirestore(app);

// // // Expose auth + db to window so legacy inline scripts can reference them
// // window._fbAuth = auth;
// // window._fbDb   = db;


// // // ════════════════════════════════════════════════════════════════════════════
// // //  HELPERS
// // // ════════════════════════════════════════════════════════════════════════════

// // /** Map Firebase auth error codes to user-friendly messages. */
// // function friendlyAuthError(code) {
// //   const map = {
// //     "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
// //     "auth/invalid-email":          "Please enter a valid email address.",
// //     "auth/weak-password":          "Password is too weak — minimum 6 characters.",
// //     "auth/user-not-found":         "No account found with that email.",
// //     "auth/wrong-password":         "Incorrect password. Please try again.",
// //     "auth/invalid-credential":     "Incorrect email or password.",
// //     "auth/network-request-failed": "Network error — please check your connection and try again.",
// //     "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
// //   };
// //   return map[code] || "Authentication error. Please try again.";
// // }

// // /** Check whether a Firestore "restrictedUsers" doc exists for this email. */
// // async function checkUserNotRestricted(email) {
// //   const docId = email.toLowerCase().replace(/[@.]/g, "_");
// //   try {
// //     const snap = await getDoc(doc(db, "restrictedUsers", docId));
// //     if (snap.exists()) return false;
// //   } catch (_) {}
// //   return true;
// // }

// // /** Check whether the global settings allow new registrations. */
// // async function checkRegistrationOpen() {
// //   try {
// //     const snap = await getDoc(doc(db, "settings", "global"));
// //     if (snap.exists() && snap.data().registrationClosed === true) return false;
// //   } catch (err) {
// //     // permission-denied means the rules block unauthenticated reads on settings/global
// //     // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
// //     if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
// //   }
// //   return true;
// // }

// // /** Safely read a DOM element value. */
// // const gv = (id) => document.getElementById(id)?.value ?? "";

// // /** Read all active chip texts from a CSS selector. */
// // const activeChips = (sel) =>
// //   [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// // // ════════════════════════════════════════════════════════════════════════════
// // //  COLLECT FORM DATA
// // //  Reads every field on the assessment form into a plain JS object.
// // //  Called by saveAssessmentData() and the legacy submitForm().
// // // ════════════════════════════════════════════════════════════════════════════

// // function collectFormData() {
// //   // Safe field reader — returns "-" if element missing or value empty
// //   const fv = (id) => { const el = document.getElementById(id); return (el?.value || "").trim() || "-"; };
// //   const fb = (id) => { const el = document.getElementById(id); return el ? (el.checked ? "Yes" : "No") : "-"; };
// //   const fc = (sel) => { const r = [...document.querySelectorAll(sel + ".active")].map(c => c.textContent.trim()); return r.length ? r.join(", ") : "-"; };
// //   const fm = (key) => { const r = ((window.msddState || {})[key] || []); return r.length ? r.join(", ") : "-"; };

// //   const d   = window._lastCalcData || {};
// //   const ht  = d.ht  || 0;
// //   const wt  = d.wt  || 0;
// //   const bmiNum = ht > 0 ? wt / ((ht / 100) ** 2) : 0;
// //   const bmiCat = bmiNum < 18.5 ? "Underweight" : bmiNum < 25 ? "Normal" : bmiNum < 30 ? "Overweight" : "Obese";

// //   const waistVal = parseFloat(document.getElementById("inp-waist")?.value) || 0;
// //   const neckVal  = parseFloat(document.getElementById("inp-neck")?.value)  || 0;
// //   const hipVal   = parseFloat(document.getElementById("inp-hip")?.value)   || 0;
// //   const gender   = document.getElementById("inp-gender")?.value || d.gender || "";

// //   // Weekend eating rule
// //   const werEnabled    = document.getElementById("wer-yes-btn")?.classList.contains("active") ? "Yes" : "No";
// //   const werDays       = [...document.querySelectorAll(".wer-day-chip.active")].map(c => c.dataset.day || c.textContent.trim());
// //   const werRule       = [...document.querySelectorAll(".wer-rule-chip.active")].map(c => c.dataset.rule || c.textContent.trim());
// //   const werCustom     = (document.getElementById("wer-custom-input")?.value || "").trim();
// //   const werRepeatDays = [...document.querySelectorAll(".wer-repeat-chip.active")].map(c => c.textContent.trim());

// //   const planForSelf = window._planForSelf !== false;

// //   return {
// //     // ── IDs & metadata ──
// //     timestamp: new Date().toISOString(),

// //     // ── Plan context ──
// //     plan_for:            planForSelf ? "Self" : "Other",
// //     plan_other_name:     planForSelf ? "-" : (document.getElementById("plan-other-name")?.value || "-").trim(),
// //     plan_other_relation: planForSelf ? "-" : (document.getElementById("plan-other-relation")?.value || "-").trim(),

// //     // ── Personal details ──
// //     name:   (document.getElementById("inp-name")?.value || "").trim() || "-",
// //     age:    fv("inp-age"),
// //     gender: gender || "-",
// //     phone:  fv("inp-phone"),
// //     email:  fv("inp-email"),

// //     // ── Body measurements ──
// //     height:           ht ? String(ht) : "-",
// //     height_unit:      (document.querySelector(".hcb-tab.active")?.textContent || "-").trim(),
// //     weight:           wt ? String(wt) : "-",
// //     waist:            waistVal ? String(waistVal) : "-",
// //     neck:             neckVal  ? String(neckVal)  : "-",
// //     hip:              (gender === "Female" && hipVal) ? String(hipVal) : (gender === "Female" ? "-" : "N/A"),
// //     pregnancy_status: fv("inp-preg"),
// //     // Save the human-readable label (e.g. "Sedentary — Little or no exercise…")
// //     // rather than the raw factor number so admin sees meaningful text.
// //     activity_level: (() => {
// //       const sel = document.getElementById("inp-activity");
// //       if (!sel || !sel.value) return "-";
// //       const opt = sel.options[sel.selectedIndex];
// //       return opt ? opt.text.trim() : sel.value;
// //     })(),
// //     activity_factor: fv("inp-activity"),  // keep the numeric factor for calculations

// //     // ── Calculated metrics ──
// //     bmi:                  bmiNum > 0 ? bmiNum.toFixed(1) : "-",
// //     bmi_category:         bmiNum > 0 ? bmiCat : "-",
// //     body_fat:             "-",  // computed from measurements only at submit time
// //     ideal_weight:         d.idealWeight ? d.idealWeight.toFixed(1) : "-",
// //     current_weight:       wt ? String(wt) : "-",
// //     weight_to_goal:       d.kgDiff ? d.kgDiff.toFixed(1) + " kg" : "-",
// //     goal_direction:       d.direction || "-",
// //     bmr:                  d.bmr ? String(Math.round(d.bmr)) : "-",
// //     maintenance_calories: d.maintenance ? String(d.maintenance) : "-",
// //     goal_calories: (() => {
// //       if (!d.maintenance) return "-";
// //       const rate = window._currentGoalRate || 0.5;
// //       let gc = d.direction === "loss" ? d.maintenance - Math.round(rate * 1000)
// //              : d.direction === "gain" ? d.maintenance + Math.round(rate * 600)
// //              : d.maintenance;
// //       return String(Math.max(1000, gc));
// //     })(),
// //     goal_rate_kg_per_week: String(window._currentGoalRate || 0.5),
// //     timeline_days: (() => {
// //       if (!d.kgDiff || d.direction === "maintain") return "-";
// //       return String(Math.round((d.kgDiff / (window._currentGoalRate || 0.5)) * 7));
// //     })(),
// //     after_goal_calories: (() => {
// //       if (!d.idealWeight || !ht || !d.age) return "-";
// //       const afterBmr = gender === "Female"
// //         ? (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) - 161
// //         : (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) + 5;
// //       return String(Math.round(afterBmr * (parseFloat(d.activity) || 1.2)));
// //     })(),

// //     // ── Health ──
// //     health_conditions: [...(window.selectedConditions ?? new Set())].join(", ") || "-",
// //     allergies:         fv("inp-allergies"),

// //     // ── Diet preferences ──
// //     diet_preference: fv("inp-diet"),
// //     num_curries:     fv("inp-curries"),
// //     meal_types:      fc("#meal-types .chip"),
// //     eating_window:   fv("eat-window-val"),

// //     // ── Weekend eating rule ──
// //     weekend_eating_rule:        werEnabled,
// //     weekend_eating_days:        werDays.length    ? werDays.join(", ")    : "-",
// //     weekend_eating_rule_type:   werRule.length    ? werRule.join(", ")    : "-",
// //     weekend_eating_custom_rule: werCustom         || "-",
// //     weekend_eating_repeat_days: werRepeatDays.length ? werRepeatDays.join(", ") : "-",

// //     // ── Food preferences — MSDD dropdowns ──
// //     morning_drinks:  fm("msdd-drinks"),
// //     nuts:            fm("msdd-nuts"),
// //     seeds:           fm("msdd-seeds"),
// //     fruits:          fm("msdd-fruits"),
// //     vegetables:      fm("msdd-veggies"),
// //     sprouts:         fm("msdd-sprouts"),
// //     milkshakes:      fm("msdd-milkshakes"),
// //     smoothies:       fm("msdd-smoothies"),
// //     porridge_malt:   fm("msdd-porridge"),
// //     breakfast:       fm("msdd-breakfast"),
// //     chutney:         fm("msdd-chutney"),
// //     powders_ghee:    fm("msdd-powders"),
// //     non_veg:         fm("msdd-nonveg"),
// //     rice:            fm("msdd-rice"),
// //     millets_grains:  fm("msdd-millets"),

// //     // ── Symptoms & final notes ──
// //     symptoms:         fc("#symptoms-group .chip"),
// //     food_dislikes:    fv("inp-dislikes"),
// //     comments:         fv("inp-comments"),
// //     whatsapp_consent: fb("consent-wa"),
// //   };
// // }



// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveAssessmentData(uid)
// // //  Writes all assessment fields + metadata to Firestore under the user's UID.
// // //
// // //  Firestore structure:
// // //    users/{uid}/profile          — name, email, phone
// // //    users/{uid}/assessment/current — full assessment snapshot
// // //    users/{uid}/progress         — goals, BMI, body fat, timestamps
// // //
// // //  Also writes to legacy submissions/{submissionId} for admin compatibility.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function saveAssessmentData(uid, submissionId) {
// //   if (!uid) {
// //     console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
// //     return;
// //   }

// //   const data = collectFormData();
// //   const now  = serverTimestamp();

// //   try {
// //     // 1. Profile document (quick lookup fields)
// //     await setDoc(
// //       doc(db, "users", uid, "profile", "info"),
// //       {
// //         name:      data.name,
// //         email:     data.email || auth.currentUser?.email || "",
// //         phone:     data.phone,
// //         updatedAt: now,
// //       },
// //       { merge: true }
// //     );

// //     // 2. Full assessment snapshot (overwrites on each save)
// //     await setDoc(
// //       doc(db, "users", uid, "assessment", "current"),
// //       {
// //         ...data,
// //         uid,
// //         submissionId: submissionId || "",
// //         savedAt: now,
// //       }
// //     );

// //     // 3. Progress / goal metrics document
// //     await setDoc(
// //       doc(db, "users", uid, "progress", "latest"),
// //       {
// //         bmi:              data.bmi,
// //         bmi_category:     data.bmi_category,
// //         body_fat:         data.body_fat,
// //         ideal_weight:     data.ideal_weight,
// //         goal_direction:   data.goal_direction,
// //         goal_calories:    data.goal_calories,
// //         maintenance_calories: data.maintenance_calories,
// //         bmr:              data.bmr,
// //         recordedAt:       now,
// //       },
// //       { merge: true }
// //     );

// //     console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
// //   } catch (err) {
// //     console.error("[NP Firebase] saveAssessmentData error:", err);
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  loadAssessmentData(uid)
// // //  Reads users/{uid}/assessment/current and restores the form.
// // //  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function loadAssessmentData(uid) {
// //   let data = null;

// //   if (uid) {
// //     try {
// //       const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
// //       if (snap.exists()) {
// //         data = snap.data();
// //         console.info("[NP Firebase] Assessment loaded from Firestore.");
// //       }
// //     } catch (err) {
// //       console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
// //     }
// //   }

// //   // Fall back to localStorage draft
// //   if (!data) {
// //     try {
// //       const raw = localStorage.getItem("nutriplan_ls_draft");
// //       if (raw) data = JSON.parse(raw);
// //       if (data) console.info("[NP Firebase] Assessment loaded from localStorage draft.");
// //     } catch (_) {}
// //   }

// //   if (!data) return; // Nothing to restore

// //   // ── Restore simple text/number/select fields ──
// //   const set = (id, val) => {
// //     const el = document.getElementById(id);
// //     if (el && val !== undefined && val !== null && val !== "") el.value = val;
// //   };

// //   set("inp-name",     data.name);
// //   set("inp-age",      data.age);
// //   set("inp-phone",    data.phone);
// //   set("inp-email",    data.email);
// //   set("inp-allergies",data.allergies);
// //   set("inp-dislikes", data.food_dislikes);
// //   set("inp-comments", data.comments);
// //   set("inp-curries",  data.num_curries);
// //   set("eat-window-val", data.eating_window);

// //   if (data.height) {
// //     set("inp-height",    data.height);
// //     set("inp-height-cm", Math.round(data.height));
// //   }
// //   set("inp-weight",   data.weight);
// //   set("inp-preg",     data.pregnancy_status);

// //   // Measurements
// //   ["waist", "neck", "hip"].forEach((m) => {
// //     const val = data[m];
// //     if (!val) return;
// //     const raw = document.getElementById(m + "-raw-input");
// //     const hid = document.getElementById("inp-" + m);
// //     if (raw) raw.value = val;
// //     if (hid) hid.value = val;
// //   });

// //   // Gender (triggers female row visibility)
// //   if (data.gender) {
// //     set("inp-gender", data.gender);
// //     const femRow = document.getElementById("female-extra-row");
// //     if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
// //   }

// //   // activity_factor stores the numeric select value; activity_level stores the label (new). Support both.
// //   if (data.activity_factor && data.activity_factor !== "-") set("inp-activity", data.activity_factor);
// //   else if (data.activity_level && /^\d/.test(data.activity_level)) set("inp-activity", data.activity_level); // legacy fallback
// //   if (data.diet_preference) set("inp-diet",     data.diet_preference);
// //   if (document.getElementById("consent-wa"))
// //     document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

// //   // ── Restore chip selections ──
// //   const restoreChips = (selector, csvString) => {
// //     if (!csvString) return;
// //     const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
// //     document.querySelectorAll(selector).forEach((chip) => {
// //       if (active.includes(chip.textContent.trim())) chip.classList.add("active");
// //     });
// //   };
// //   restoreChips("#meal-types .chip",      data.meal_types);
// //   restoreChips("#symptoms-group .chip",  data.symptoms);

// //   // Eating time chip
// //   if (data.eating_window) {
// //     document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
// //       if (tc.dataset.value === data.eating_window) tc.classList.add("active");
// //     });
// //   }

// //   // ── Restore Weekend Eating Rule ──
// //   if (data.weekend_eating_rule === "Yes") {
// //     const yesBtn = document.getElementById("wer-yes-btn");
// //     const noBtn  = document.getElementById("wer-no-btn");
// //     if (yesBtn) { yesBtn.classList.add("active"); }
// //     if (noBtn)  { noBtn.classList.remove("active"); }
// //     // Show the WER panel if it exists
// //     const werPanel = document.getElementById("wer-panel") || document.querySelector(".wer-options");
// //     if (werPanel) werPanel.style.display = "block";
// //   }
// //   // Restore selected WER days
// //   if (data.weekend_eating_days && data.weekend_eating_days !== "-") {
// //     const days = data.weekend_eating_days.split(",").map(v => v.trim()).filter(Boolean);
// //     document.querySelectorAll(".wer-day-chip").forEach(chip => {
// //       const d2 = chip.dataset.day || chip.textContent.trim();
// //       if (days.includes(d2)) chip.classList.add("active");
// //     });
// //   }
// //   // Restore WER rule chips
// //   if (data.weekend_eating_rule_type && data.weekend_eating_rule_type !== "-") {
// //     const rules = data.weekend_eating_rule_type.split(",").map(v => v.trim()).filter(Boolean);
// //     document.querySelectorAll(".wer-rule-chip").forEach(chip => {
// //       if (rules.includes(chip.dataset.rule || chip.textContent.trim())) chip.classList.add("active");
// //     });
// //   }
// //   // Restore WER custom text
// //   if (data.weekend_eating_custom_rule && data.weekend_eating_custom_rule !== "-") {
// //     const werCustom = document.getElementById("wer-custom-input");
// //     if (werCustom) werCustom.value = data.weekend_eating_custom_rule;
// //   }
// //   // Restore WER repeat-days chips
// //   if (data.weekend_eating_repeat_days && data.weekend_eating_repeat_days !== "-") {
// //     const repeatDays = data.weekend_eating_repeat_days.split(",").map(v => v.trim()).filter(Boolean);
// //     document.querySelectorAll(".wer-repeat-chip").forEach(chip => {
// //       if (repeatDays.includes(chip.textContent.trim())) chip.classList.add("active");
// //     });
// //     // Show repeat row if chips are active
// //     const repeatRow = document.getElementById("wer-repeat-row");
// //     if (repeatRow) repeatRow.style.display = "flex";
// //   }

// //   // ── Restore MSDD dropdowns ──
// //   const msddMap = {
// //     "msdd-drinks":    data.morning_drinks,
// //     "msdd-fruits":    data.fruits,
// //     "msdd-veggies":   data.vegetables,
// //     "msdd-sprouts":   data.sprouts,
// //     "msdd-milkshakes":data.milkshakes,
// //     "msdd-smoothies": data.smoothies,
// //     "msdd-porridge":  data.porridge_malt,
// //     "msdd-breakfast": data.breakfast,
// //     "msdd-chutney":   data.chutney,
// //     "msdd-powders":   data.powders_ghee,
// //     "msdd-nonveg":    data.non_veg,
// //     "msdd-rice":      data.rice,
// //     "msdd-millets":   data.millets_grains,
// //   };
// //   Object.entries(msddMap).forEach(([id, csv]) => {
// //     if (!csv) return;
// //     csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
// //       const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
// //       if (cb) cb.checked = true;
// //     });
// //     if (typeof window.msddChange === "function") window.msddChange(id);
// //   });

// //   // Nuts + seeds (stored combined in "nuts_seeds")
// //   if (data.nuts_seeds) {
// //     data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
// //       ["msdd-nuts", "msdd-seeds"].forEach((id) => {
// //         const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
// //         if (cb) cb.checked = true;
// //       });
// //     });
// //     if (typeof window.msddChange === "function") {
// //       window.msddChange("msdd-nuts");
// //       window.msddChange("msdd-seeds");
// //     }
// //   }

// //   // ── Restore health conditions ──
// //   if (data.health_conditions) {
// //     const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
// //     conds.forEach((v) => {
// //       if (window.selectedConditions) window.selectedConditions.add(v);
// //       const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
// //       if (cb) cb.checked = true;
// //     });
// //     if (typeof window.renderTags === "function") window.renderTags();
// //   }

// //   // Open hidden sections that were visible
// //   ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
// //     setTimeout(() => {
// //       const el = document.getElementById(id);
// //       if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
// //     }, i * 100);
// //   });

// //   console.info("[NP Firebase] Form restored from saved data.");
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveLocalStorageDraft()
// // //  Writes a lightweight draft to localStorage for users who skip sign-in.
// // //  Called by autoSaveAssessment() when not signed in.
// // // ════════════════════════════════════════════════════════════════════════════

// // function saveLocalStorageDraft() {
// //   try {
// //     const data = collectFormData();
// //     localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
// //   } catch (err) {
// //     console.warn("[NP Firebase] localStorage backup error:", err);
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  AUTO-SAVE LOGIC
// // //  When signed in: debounce-saves to Firestore after 5 s of inactivity.
// // //  When not signed in: saves to localStorage after 3 s of inactivity.
// // //  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// // // ════════════════════════════════════════════════════════════════════════════

// // let _autoSaveTimer   = null;
// // let _autoSaveEnabled = false;

// // /** Trigger a debounced auto-save. Call this from form input listeners. */
// // function scheduleAutoSave() {
// //   if (!_autoSaveEnabled) return;
// //   clearTimeout(_autoSaveTimer);

// //   const user = auth.currentUser;
// //   const delay = user ? 5000 : 3000;

// //   _autoSaveTimer = setTimeout(async () => {
// //     if (auth.currentUser) {
// //       // Auto-save to Firestore
// //       await saveAssessmentData(auth.currentUser.uid);
// //     } else {
// //       // Auto-save to localStorage
// //       saveLocalStorageDraft();
// //     }
// //   }, delay);
// // }

// // /** Start auto-save listeners on all form inputs. */
// // function autoSaveAssessment() {
// //   _autoSaveEnabled = true;

// //   const attach = () => {
// //     document.querySelectorAll("input, select, textarea").forEach((el) => {
// //       if (!el.dataset._npAutoSave) {
// //         el.dataset._npAutoSave = "1";
// //         el.addEventListener("input",  scheduleAutoSave);
// //         el.addEventListener("change", scheduleAutoSave);
// //       }
// //     });
// //     // Chips and toggle buttons
// //     document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
// //       if (!el.dataset._npAutoSave) {
// //         el.dataset._npAutoSave = "1";
// //         el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
// //       }
// //     });
// //   };

// //   attach();
// //   // Re-attach after any dynamically rendered chips
// //   new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

// //   console.info("[NP Firebase] Auto-save enabled.");
// // }

// // /** Pause auto-save (e.g. while a modal is open or after final submission). */
// // function stopAutoSave() {
// //   _autoSaveEnabled = false;
// //   clearTimeout(_autoSaveTimer);
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  createAccount(email, password)
// // //  Creates a new Firebase Auth user and saves assessment data.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function createAccount(email, password) {
// //   // Validate inputs
// //   if (!email || !/\S+@\S+\.\S+/.test(email))
// //     return { ok: false, error: "Enter a valid email address." };
// //   if (password.length < 6)
// //     return { ok: false, error: "Password must be at least 6 characters." };

// //   // Check server-side gates
// //   const regOpen = await checkRegistrationOpen();
// //   if (!regOpen)
// //     return { ok: false, error: "New registrations are currently closed." };

// //   const allowed = await checkUserNotRestricted(email);
// //   if (!allowed)
// //     return { ok: false, error: "This email address is not allowed to register." };

// //   try {
// //     // Create Firebase Auth account
// //     const cred = await createUserWithEmailAndPassword(auth, email, password);
// //     const uid  = cred.user.uid;

// //     // Persist account metadata
// //     await setDoc(
// //       doc(db, "accounts", uid),
// //       { email, createdAt: serverTimestamp() }
// //     );

// //     // Save all pending assessment data to Firestore
// //     if (window._pendingFormData) {
// //       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
// //     }
// //     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

// //     // Store session hints
// //     localStorage.setItem("nutriplan_uid",   uid);
// //     localStorage.setItem("nutriplan_email", email);
// //     // Remove localStorage draft — it's now in Firestore
// //     localStorage.removeItem("nutriplan_ls_draft");

// //     console.info("[NP Firebase] Account created:", email, uid);
// //     return { ok: true, uid, email };
// //   } catch (err) {
// //     console.error("[NP Firebase] createAccount error:", err.code, err.message);
// //     return { ok: false, error: friendlyAuthError(err.code) };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  loginUser(email, password)
// // //  Signs the user in and saves any pending assessment data.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function loginUser(email, password) {
// //   if (!email || !/\S+@\S+\.\S+/.test(email))
// //     return { ok: false, error: "Enter a valid email address." };
// //   if (!password)
// //     return { ok: false, error: "Enter your password." };

// //   const allowed = await checkUserNotRestricted(email);
// //   if (!allowed)
// //     return { ok: false, error: "This account has been restricted." };

// //   try {
// //     const cred = await signInWithEmailAndPassword(auth, email, password);
// //     const uid  = cred.user.uid;

// //     // Save pending assessment data
// //     if (window._pendingFormData) {
// //       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
// //     }
// //     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

// //     localStorage.setItem("nutriplan_uid",   uid);
// //     localStorage.setItem("nutriplan_email", email);
// //     localStorage.removeItem("nutriplan_ls_draft");

// //     console.info("[NP Firebase] Signed in:", email, uid);
// //     return { ok: true, uid, email };
// //   } catch (err) {
// //     console.error("[NP Firebase] loginUser error:", err.code, err.message);
// //     return { ok: false, error: friendlyAuthError(err.code) };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  logoutUser()
// // //  Signs out of Firebase Auth and clears session hints.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function logoutUser() {
// //   try {
// //     stopAutoSave();
// //     await fbSignOut(auth);

// //     localStorage.removeItem("nutriplan_uid");
// //     localStorage.removeItem("nutriplan_email");
// //     localStorage.removeItem("np_auth");

// //     console.info("[NP Firebase] Signed out.");
// //     return { ok: true };
// //   } catch (err) {
// //     console.error("[NP Firebase] logoutUser error:", err.message);
// //     return { ok: false, error: err.message };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
// // //  Mirrors a submission to the "submissions" collection used by admin tools.
// // //  Preserved 100% from the original firebase module so nothing breaks.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
// //   try {
// //     const isEdit = !!(formData._editUid);
// //     let resolvedUid = accountUid || null;
// //     if (isEdit) {
// //       try {
// //         const snap = await getDoc(doc(db, "submissions", formData.userId));
// //         if (snap.exists() && snap.data().accountUid)
// //           resolvedUid = snap.data().accountUid;
// //       } catch (_) {}
// //     }
// //     const entry = {
// //       ...formData,
// //       accountUid: resolvedUid,
// //       forSelf:    forSelf !== false,
// //       relName:    relName  || "",
// //       relation:   relation || "",
// //       ...(isEdit
// //         ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
// //         : { createdAt: serverTimestamp() }),
// //     };
// //     delete entry._editUid;
// //     await setDoc(
// //       doc(db, "submissions", formData.userId),
// //       entry,
// //       isEdit ? { merge: false } : {}
// //     );
// //     if (resolvedUid) {
// //       await setDoc(
// //         doc(db, "accounts", resolvedUid, "profiles", formData.userId),
// //         {
// //           userId:    formData.userId,
// //           name:      formData.name,
// //           forSelf:   entry.forSelf,
// //           relName:   entry.relName,
// //           relation:  entry.relation,
// //           timestamp: formData.timestamp,
// //         }
// //       );
// //     }
// //   } catch (err) {
// //     console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
// //   }
// // }

// // // Expose legacy function under original name so existing inline code still works
// // window.saveToFirestore = saveToFirestoreLegacy;


// // // ════════════════════════════════════════════════════════════════════════════
// // //  onAuthStateChanged — central auth observer
// // //  • Signed in  → show avatar with initials, preload saved form data
// // //  • Signed out → show "Sign In" button, try loading localStorage draft
// // // ════════════════════════════════════════════════════════════════════════════

// // onAuthStateChanged(auth, async (user) => {
// //   const profileBtn = document.getElementById("nav-profile-btn");
// //   const signinBtn  = document.getElementById("nav-signin-btn");
// //   const step0Block = document.getElementById("step0-block");

// //   if (user) {
// //     // Restriction check
// //     const allowed = await checkUserNotRestricted(user.email || "");
// //     if (!allowed) {
// //       await fbSignOut(auth);
// //       localStorage.removeItem("np_auth");
// //       if (profileBtn) profileBtn.classList.remove("show");
// //       if (signinBtn)  signinBtn.classList.add("show");
// //       return;
// //     }

// //     // Show avatar with email initial
// //     if (profileBtn) {
// //       const initial = (user.email || "U")[0].toUpperCase();
// //       profileBtn.textContent = initial;
// //       profileBtn.classList.add("show");
// //     }
// //     if (signinBtn) signinBtn.classList.remove("show");

// //     // Start auto-save now that the user is authenticated
// //     autoSaveAssessment();

// //     // Pre-load any previously saved assessment data into the form
// //     // (only if no session draft is present, to avoid overwriting a fresh session)
// //     const hasSessionDraft = !!sessionStorage.getItem("nutriplan_draft");
// //     if (!hasSessionDraft) {
// //       await loadAssessmentData(user.uid);
// //     }

// //   } else {
// //     // Not signed in
// //     localStorage.removeItem("np_auth");
// //     if (profileBtn) profileBtn.classList.remove("show");
// //     if (signinBtn)  signinBtn.classList.add("show");
// //     if (step0Block) step0Block.style.display = "none";

// //     // Still start auto-save so localStorage draft stays fresh
// //     autoSaveAssessment();
// //   }
// // });


// // // ════════════════════════════════════════════════════════════════════════════
// // //  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
// // //  Re-uses the exact same logic from the original firebase module.
// // // ════════════════════════════════════════════════════════════════════════════

// // window._regClosed = true;

// // onSnapshot(doc(db, "settings", "global"), (snap) => {
// //   if (snap.exists()) {
// //     const data        = snap.data();
// //     const formClosed  = !!data.formSubmissionClosed;
// //     const regClosed   = !!data.registrationClosed;

// //     if (typeof window.applyFormClosedState === "function")
// //       window.applyFormClosedState(formClosed);

// //     window._regClosed = regClosed;

// //     // Keep modal tabs in sync if modal is open
// //     const modal = document.getElementById("accountModal");
// //     if (modal && modal.style.display === "flex") {
// //       if (regClosed) {
// //         if (typeof window.applyModalRegClosedState === "function")
// //           window.applyModalRegClosedState();
// //       } else {
// //         ["create", "login"].forEach((t) => {
// //           const tab = document.getElementById("tab-" + t);
// //           if (tab) {
// //             tab.classList.remove("active");
// //             tab.style.opacity = "";
// //             tab.style.cursor  = "";
// //             tab.style.pointerEvents = "";
// //             tab.title = "";
// //           }
// //         });
// //         document.getElementById("tab-create")?.classList.add("active");
// //         const authCreate = document.getElementById("auth-create");
// //         const authLogin  = document.getElementById("auth-login");
// //         if (authCreate) authCreate.style.display = "block";
// //         if (authLogin)  authLogin.style.display  = "none";
// //         const notice = document.getElementById("modal-reg-closed-notice");
// //         if (notice) notice.style.display = "none";
// //       }
// //     }
// //   } else {
// //     if (typeof window.applyFormClosedState === "function")
// //       window.applyFormClosedState(false);
// //     window._regClosed = false;
// //   }
// // }, (err) => {
// //   // "Missing or insufficient permissions" is expected when the user is signed out
// //   // and Firestore rules require auth for this document.
// //   // Fix: set `allow read: if true` on settings/global in your Firestore rules.
// //   // We only log unexpected errors (not permission denials).
// //   if (err.code !== 'permission-denied') {
// //     console.warn("[NP Firebase] settings read error:", err.code, err.message);
// //   }
// // });


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PASSWORD RESET
// // //  Exposed globally so the existing forgotModal can call it.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.doResetPassword = async function () {
// //   const email = document.getElementById("fp-email")?.value?.trim();
// //   const errEl = document.getElementById("fp-err");
// //   const sucEl = document.getElementById("fp-suc");
// //   if (errEl) errEl.style.display = "none";
// //   if (sucEl) sucEl.style.display = "none";

// //   if (!email || !/\S+@\S+\.\S+/.test(email)) {
// //     if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
// //     return;
// //   }
// //   try {
// //     await sendPasswordResetEmail(auth, email);
// //     if (sucEl) {
// //       sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
// //       sucEl.style.display = "block";
// //     }
// //     setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
// //   } catch (err) {
// //     if (errEl) {
// //       errEl.textContent = err.code === "auth/user-not-found"
// //         ? "No account found with this email."
// //         : friendlyAuthError(err.code);
// //       errEl.style.display = "block";
// //     }
// //   }
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
// // //  These override the window.createAccount and window.signInExisting
// // //  originally defined inline in onboarding.html.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.createAccount = async function () {
// //   const errEl = document.getElementById("acct-err");
// //   if (errEl) errEl.style.display = "none";

// //   if (window._regClosed) {
// //     if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
// //     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
// //     return;
// //   }

// //   const email = document.getElementById("acct-email")?.value?.trim() ?? "";
// //   const pass  = document.getElementById("acct-pass")?.value  ?? "";
// //   const pass2 = document.getElementById("acct-pass2")?.value ?? "";

// //   if (pass !== pass2) {
// //     if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Disable button while working
// //   const btn = document.querySelector("#auth-create .btn-primary");
// //   if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

// //   const result = await createAccount(email, pass);

// //   if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

// //   if (!result.ok) {
// //     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Success — store local profile reference and redirect
// //   if (window._pendingFormData) {
// //     if (typeof window.saveLocalProfile === "function")
// //       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
// //         window._isForSelf, window._relName, window._relation);
// //   }
// //   window.location.href = "dietplan.html";
// // };


// // window.signInExisting = async function () {
// //   const errEl = document.getElementById("login-err");
// //   if (errEl) errEl.style.display = "none";

// //   const email = document.getElementById("login-email")?.value?.trim() ?? "";
// //   const pass  = document.getElementById("login-pass")?.value ?? "";

// //   const btn = document.querySelector("#auth-login .btn-primary");
// //   if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

// //   const result = await loginUser(email, pass);

// //   if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

// //   if (!result.ok) {
// //     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Success — store local profile reference and redirect
// //   if (window._pendingFormData) {
// //     if (typeof window.saveLocalProfile === "function")
// //       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
// //         window._isForSelf, window._relName, window._relation);
// //   }
// //   window.location.href = "dietplan.html";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  SIGN OUT (called by avatar dropdown)
// // //  Replaces the doSignOut() function defined in the non-module <script>.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.doSignOut = async function () {
// //   const result = await logoutUser();
// //   if (result.ok) {
// //     document.getElementById("nav-profile-btn")?.classList.remove("show");
// //     const signinBtn = document.getElementById("nav-signin-btn");
// //     if (signinBtn) signinBtn.classList.add("show");
// //     document.getElementById("avatar-dropdown")?.classList.remove("open");
// //     window.location.href = "Dietplan.html";
// //   } else {
// //     localStorage.removeItem("np_auth");
// //     window.location.reload();
// //   }
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  UNREAD MESSAGES CHECK (unchanged from original)
// // // ════════════════════════════════════════════════════════════════════════════

// // async function checkUnreadMessages(uid) {
// //   try {
// //     const { collection: col, getDocs: gd, query: q, where: w } =
// //       await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
// //     const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
// //     if (!snap.empty) {
// //       const dot = document.getElementById("nav-msg-dot");
// //       if (dot) dot.style.display = "inline-block";
// //     }
// //   } catch (_) {}
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PASSWORD VISIBILITY TOGGLE
// // // ════════════════════════════════════════════════════════════════════════════

// // window.togglePw = function (inputId, btn) {
// //   const inp = document.getElementById(inputId);
// //   if (!inp) return;
// //   const isText = inp.type === "text";
// //   inp.type  = isText ? "password" : "text";
// //   btn.textContent = isText ? "👁" : "🙈";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  ACCOUNT MODAL HELPERS (unchanged from original)
// // // ════════════════════════════════════════════════════════════════════════════

// // window.proceedToAuth = function () {
// //   document.getElementById("acct-step-save").style.display = "none";
// //   const user = auth.currentUser;
// //   if (user) {
// //     (async () => {
// //       await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
// //       await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
// //       if (typeof window.saveLocalProfile === "function")
// //         window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
// //       const isEdit = !!window._pendingFormData?._editUid;
// //       if (typeof window.showAccountDone === "function")
// //         window.showAccountDone(
// //           "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
// //           isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
// //         );
// //     })();
// //   } else {
// //     const authStep = document.getElementById("acct-step-auth");
// //     if (authStep) authStep.style.display = "block";
// //   }
// // };

// // window.switchAuthTab = function (tab) {
// //   if (tab === "create" && window._regClosed) {
// //     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
// //     return;
// //   }
// //   ["create", "login"].forEach((t) => {
// //     document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
// //   });
// //   const authCreate = document.getElementById("auth-create");
// //   const authLogin  = document.getElementById("auth-login");
// //   if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
// //   if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
// // };

// // window.skipAccount = function () { window.closeAccountModal(); };
// // window.closeAccountModal = function () {
// //   const m = document.getElementById("accountModal");
// //   if (m) m.style.display = "none";
// //   // Save to localStorage as backup since user skipped sign-in
// //   saveLocalStorageDraft();
// // };

// // window.openAccountModal = function (formData) {
// //   window._pendingFormData = formData;
// //   window._isForSelf  = window._planForSelf   !== false;
// //   window._relName    = window._planOtherName  || "";
// //   window._relation   = window._planOtherRelation || "";
// //   document.getElementById("acct-step-save").style.display  = "block";
// //   document.getElementById("acct-step-auth").style.display  = "none";
// //   document.getElementById("acct-step-done").style.display  = "none";
// //   const m = document.getElementById("accountModal");
// //   if (m) m.style.display = "flex";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PUBLIC API — exposed on window.NP_FB for external scripts
// // // ════════════════════════════════════════════════════════════════════════════

// // window.NP_FB = {
// //   auth,
// //   db,
// //   createAccount,
// //   loginUser,
// //   logoutUser,
// //   saveAssessmentData,
// //   loadAssessmentData,
// //   autoSaveAssessment,
// //   stopAutoSave,
// //   saveLocalStorageDraft,
// //   collectFormData,
// // };

// // // Also expose the firebase instances directly (backwards compat)
// // window.auth = auth;
// // window.db   = db;





















// // /**
// //  * ═══════════════════════════════════════════════════════════════
// //  *  firebase.js  —  NutriPlan Firebase Integration Module
// //  *  All Firebase Auth + Firestore logic lives here.
// //  *  Imported by onboarding.html as a ES module script.
// //  * ═══════════════════════════════════════════════════════════════
// //  *
// //  *  EXPORTS (attached to window for non-module scripts to call):
// //  *    window.NP_FB = {
// //  *      auth, db,
// //  *      createAccount(), loginUser(), logoutUser(),
// //  *      saveAssessmentData(), loadAssessmentData(),
// //  *      autoSaveAssessment(), stopAutoSave()
// //  *    }
// //  *
// //  *  AUTH FLOW:
// //  *    1. On page load  → onAuthStateChanged fires
// //  *       • Signed in   → show avatar, preload saved data into form
// //  *       • Signed out  → show "Sign In" button, try restoring localStorage draft
// //  *
// //  *    2. On form submit (submitForm) in onboarding.html:
// //  *       • If user NOT signed in → openAccountModal() is called
// //  *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
// //  *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
// //  *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
// //  *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
// //  *       • If user IS signed in  → saveAssessmentData() called immediately
// //  *
// //  *  SAVING FLOW (saveAssessmentData):
// //  *    Reads all form fields + calculated metrics into one flat object.
// //  *    Writes to THREE Firestore paths under the authenticated user's UID:
// //  *      • users/{uid}/profile          — name, email, phone, basic info
// //  *      • users/{uid}/assessment/current — all assessment fields + calculated data
// //  *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
// //  *    Also mirrors full submission to the legacy "submissions/{userId}" path
// //  *    so admin tools continue to work unchanged.
// //  *
// //  *  LOADING FLOW (loadAssessmentData):
// //  *    Reads users/{uid}/assessment/current from Firestore.
// //  *    Restores every form field, chip selections, MSDD dropdowns, etc.
// //  *    Falls back to localStorage draft if Firestore has no saved data.
// //  *
// //  *  AUTO-SAVE LOGIC:
// //  *    When a user is signed in, we start a 5-second debounce interval.
// //  *    Any form interaction resets the timer. After 5 s of inactivity the
// //  *    draft is persisted to Firestore (users/{uid}/assessment/current).
// //  *    Auto-save is stopped when the modal is open or the form is submitted.
// //  *
// //  *  LOCALSTORAGE BACKUP:
// //  *    When a user skips account creation OR is not signed in, the draft is
// //  *    written to localStorage under "nutriplan_ls_draft".
// //  *    On page reload, loadAssessmentData() restores it if no Firestore data
// //  *    is available.
// //  */

// // // ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
// // import { initializeApp }
// //   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// // import {
// //   getAuth,
// //   createUserWithEmailAndPassword,
// //   signInWithEmailAndPassword,
// //   signOut as fbSignOut,
// //   onAuthStateChanged,
// //   sendPasswordResetEmail,
// // } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// // import {
// //   getFirestore,
// //   doc,
// //   getDoc,
// //   setDoc,
// //   collection,
// //   serverTimestamp,
// //   onSnapshot,
// // } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// // // ── Firebase project config ──────────────────────────────────────────────────
// // const firebaseConfig = {
// //   apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
// //   authDomain:        "nutriplan-65582.firebaseapp.com",
// //   projectId:         "nutriplan-65582",
// //   storageBucket:     "nutriplan-65582.firebasestorage.app",
// //   messagingSenderId: "851509980462",
// //   appId:             "1:851509980462:web:b18af741addba334ca1ebf",
// //   measurementId:     "G-2XZZ9YW5FJ",
// // };

// // // ── Initialise Firebase ───────────────────────────────────────────────────────
// // const app  = initializeApp(firebaseConfig);
// // const auth = getAuth(app);
// // const db   = getFirestore(app);

// // // Expose auth + db to window so legacy inline scripts can reference them
// // window._fbAuth = auth;
// // window._fbDb   = db;


// // // ════════════════════════════════════════════════════════════════════════════
// // //  HELPERS
// // // ════════════════════════════════════════════════════════════════════════════

// // /** Map Firebase auth error codes to user-friendly messages. */
// // function friendlyAuthError(code) {
// //   const map = {
// //     "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
// //     "auth/invalid-email":          "Please enter a valid email address.",
// //     "auth/weak-password":          "Password is too weak — minimum 6 characters.",
// //     "auth/user-not-found":         "No account found with that email.",
// //     "auth/wrong-password":         "Incorrect password. Please try again.",
// //     "auth/invalid-credential":     "Incorrect email or password.",
// //     "auth/network-request-failed": "Network error — please check your connection and try again.",
// //     "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
// //   };
// //   return map[code] || "Authentication error. Please try again.";
// // }

// // /** Check whether a Firestore "restrictedUsers" doc exists for this email. */
// // async function checkUserNotRestricted(email) {
// //   const docId = email.toLowerCase().replace(/[@.]/g, "_");
// //   try {
// //     const snap = await getDoc(doc(db, "restrictedUsers", docId));
// //     if (snap.exists()) return false;
// //   } catch (_) {}
// //   return true;
// // }

// // /** Check whether the global settings allow new registrations. */
// // async function checkRegistrationOpen() {
// //   try {
// //     const snap = await getDoc(doc(db, "settings", "global"));
// //     if (snap.exists() && snap.data().registrationClosed === true) return false;
// //   } catch (err) {
// //     // permission-denied means the rules block unauthenticated reads on settings/global
// //     // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
// //     if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
// //   }
// //   return true;
// // }

// // /** Safely read a DOM element value. */
// // const gv = (id) => document.getElementById(id)?.value ?? "";

// // /** Read all active chip texts from a CSS selector. */
// // const activeChips = (sel) =>
// //   [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// // // ════════════════════════════════════════════════════════════════════════════
// // //  COLLECT FORM DATA
// // //  Reads every field on the assessment form into a plain JS object.
// // //  Called by saveAssessmentData() and the legacy submitForm().
// // // ════════════════════════════════════════════════════════════════════════════

// // function collectFormData() {
// //   // Safe field reader — returns "-" if element missing or value empty
// //   const fv = (id) => { const el = document.getElementById(id); return (el?.value || "").trim() || "-"; };
// //   const fb = (id) => { const el = document.getElementById(id); return el ? (el.checked ? "Yes" : "No") : "-"; };
// //   const fc = (sel) => { const r = [...document.querySelectorAll(sel + ".active")].map(c => c.textContent.trim()); return r.length ? r.join(", ") : "-"; };
// //   const fm = (key) => { const r = ((window.msddState || {})[key] || []); return r.length ? r.join(", ") : "-"; };

// //   const d   = window._lastCalcData || {};
// //   const ht  = d.ht  || 0;
// //   const wt  = d.wt  || 0;
// //   const bmiNum = ht > 0 ? wt / ((ht / 100) ** 2) : 0;
// //   const bmiCat = bmiNum < 18.5 ? "Underweight" : bmiNum < 25 ? "Normal" : bmiNum < 30 ? "Overweight" : "Obese";

// //   const waistVal = parseFloat(document.getElementById("inp-waist")?.value) || 0;
// //   const neckVal  = parseFloat(document.getElementById("inp-neck")?.value)  || 0;
// //   const hipVal   = parseFloat(document.getElementById("inp-hip")?.value)   || 0;
// //   const gender   = document.getElementById("inp-gender")?.value || d.gender || "";

// //   // Weekend eating rule
// //   const werEnabled    = document.getElementById("wer-yes-btn")?.classList.contains("active") ? "Yes" : "No";
// //   const werDays       = [...document.querySelectorAll(".wer-day-chip.active")].map(c => c.dataset.day || c.textContent.trim());
// //   const werRule       = [...document.querySelectorAll(".wer-rule-chip.active")].map(c => c.dataset.rule || c.textContent.trim());
// //   const werCustom     = (document.getElementById("wer-custom-input")?.value || "").trim();
// //   const werRepeatDays = [...document.querySelectorAll(".wer-repeat-chip.active")].map(c => c.textContent.trim());

// //   const planForSelf = window._planForSelf !== false;

// //   return {
// //     // ── IDs & metadata ──
// //     timestamp: new Date().toISOString(),

// //     // ── Plan context ──
// //     plan_for:            planForSelf ? "Self" : "Other",
// //     plan_other_name:     planForSelf ? "-" : (document.getElementById("plan-other-name")?.value || "-").trim(),
// //     plan_other_relation: planForSelf ? "-" : (document.getElementById("plan-other-relation")?.value || "-").trim(),

// //     // ── Personal details ──
// //     name:   (document.getElementById("inp-name")?.value || "").trim() || "-",
// //     age:    fv("inp-age"),
// //     gender: gender || "-",
// //     phone:  fv("inp-phone"),
// //     email:  fv("inp-email"),

// //     // ── Body measurements ──
// //     height:           ht ? String(ht) : "-",
// //     height_unit:      (document.querySelector(".hcb-tab.active")?.textContent || "-").trim(),
// //     weight:           wt ? String(wt) : "-",
// //     waist:            waistVal ? String(waistVal) : "-",
// //     neck:             neckVal  ? String(neckVal)  : "-",
// //     hip:              (gender === "Female" && hipVal) ? String(hipVal) : (gender === "Female" ? "-" : "N/A"),
// //     pregnancy_status: fv("inp-preg"),
// //     activity_level:   fv("inp-activity"),

// //     // ── Calculated metrics ──
// //     bmi:                  bmiNum > 0 ? bmiNum.toFixed(1) : "-",
// //     bmi_category:         bmiNum > 0 ? bmiCat : "-",
// //     body_fat:             "-",  // computed from measurements only at submit time
// //     ideal_weight:         d.idealWeight ? d.idealWeight.toFixed(1) : "-",
// //     current_weight:       wt ? String(wt) : "-",
// //     weight_to_goal:       d.kgDiff ? d.kgDiff.toFixed(1) + " kg" : "-",
// //     goal_direction:       d.direction || "-",
// //     bmr:                  d.bmr ? String(Math.round(d.bmr)) : "-",
// //     maintenance_calories: d.maintenance ? String(d.maintenance) : "-",
// //     goal_calories: (() => {
// //       if (!d.maintenance) return "-";
// //       const rate = window._currentGoalRate || 0.5;
// //       let gc = d.direction === "loss" ? d.maintenance - Math.round(rate * 1000)
// //              : d.direction === "gain" ? d.maintenance + Math.round(rate * 600)
// //              : d.maintenance;
// //       return String(Math.max(1000, gc));
// //     })(),
// //     goal_rate_kg_per_week: String(window._currentGoalRate || 0.5),
// //     timeline_days: (() => {
// //       if (!d.kgDiff || d.direction === "maintain") return "-";
// //       return String(Math.round((d.kgDiff / (window._currentGoalRate || 0.5)) * 7));
// //     })(),
// //     after_goal_calories: (() => {
// //       if (!d.idealWeight || !ht || !d.age) return "-";
// //       const afterBmr = gender === "Female"
// //         ? (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) - 161
// //         : (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) + 5;
// //       return String(Math.round(afterBmr * (parseFloat(d.activity) || 1.2)));
// //     })(),

// //     // ── Health ──
// //     health_conditions: [...(window.selectedConditions ?? new Set())].join(", ") || "-",
// //     allergies:         fv("inp-allergies"),

// //     // ── Diet preferences ──
// //     diet_preference: fv("inp-diet"),
// //     num_curries:     fv("inp-curries"),
// //     meal_types:      fc("#meal-types .chip"),
// //     eating_window:   fv("eat-window-val"),

// //     // ── Weekend eating rule ──
// //     weekend_eating_rule:        werEnabled,
// //     weekend_eating_days:        werDays.length    ? werDays.join(", ")    : "-",
// //     weekend_eating_rule_type:   werRule.length    ? werRule.join(", ")    : "-",
// //     weekend_eating_custom_rule: werCustom         || "-",
// //     weekend_eating_repeat_days: werRepeatDays.length ? werRepeatDays.join(", ") : "-",

// //     // ── Food preferences — MSDD dropdowns ──
// //     morning_drinks:  fm("msdd-drinks"),
// //     nuts:            fm("msdd-nuts"),
// //     seeds:           fm("msdd-seeds"),
// //     fruits:          fm("msdd-fruits"),
// //     vegetables:      fm("msdd-veggies"),
// //     sprouts:         fm("msdd-sprouts"),
// //     milkshakes:      fm("msdd-milkshakes"),
// //     smoothies:       fm("msdd-smoothies"),
// //     porridge_malt:   fm("msdd-porridge"),
// //     breakfast:       fm("msdd-breakfast"),
// //     chutney:         fm("msdd-chutney"),
// //     powders_ghee:    fm("msdd-powders"),
// //     non_veg:         fm("msdd-nonveg"),
// //     rice:            fm("msdd-rice"),
// //     millets_grains:  fm("msdd-millets"),

// //     // ── Symptoms & final notes ──
// //     symptoms:         fc("#symptoms-group .chip"),
// //     food_dislikes:    fv("inp-dislikes"),
// //     comments:         fv("inp-comments"),
// //     whatsapp_consent: fb("consent-wa"),
// //   };
// // }



// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveAssessmentData(uid)
// // //  Writes all assessment fields + metadata to Firestore under the user's UID.
// // //
// // //  Firestore structure:
// // //    users/{uid}/profile          — name, email, phone
// // //    users/{uid}/assessment/current — full assessment snapshot
// // //    users/{uid}/progress         — goals, BMI, body fat, timestamps
// // //
// // //  Also writes to legacy submissions/{submissionId} for admin compatibility.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function saveAssessmentData(uid, submissionId) {
// //   if (!uid) {
// //     console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
// //     return;
// //   }

// //   const data = collectFormData();
// //   const now  = serverTimestamp();

// //   try {
// //     // 1. Profile document (quick lookup fields)
// //     await setDoc(
// //       doc(db, "users", uid, "profile", "info"),
// //       {
// //         name:      data.name,
// //         email:     data.email || auth.currentUser?.email || "",
// //         phone:     data.phone,
// //         updatedAt: now,
// //       },
// //       { merge: true }
// //     );

// //     // 2. Full assessment snapshot (overwrites on each save)
// //     await setDoc(
// //       doc(db, "users", uid, "assessment", "current"),
// //       {
// //         ...data,
// //         uid,
// //         submissionId: submissionId || "",
// //         savedAt: now,
// //       }
// //     );

// //     // 3. Progress / goal metrics document
// //     await setDoc(
// //       doc(db, "users", uid, "progress", "latest"),
// //       {
// //         bmi:              data.bmi,
// //         bmi_category:     data.bmi_category,
// //         body_fat:         data.body_fat,
// //         ideal_weight:     data.ideal_weight,
// //         goal_direction:   data.goal_direction,
// //         goal_calories:    data.goal_calories,
// //         maintenance_calories: data.maintenance_calories,
// //         bmr:              data.bmr,
// //         recordedAt:       now,
// //       },
// //       { merge: true }
// //     );

// //     console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
// //   } catch (err) {
// //     console.error("[NP Firebase] saveAssessmentData error:", err);
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  loadAssessmentData(uid)
// // //  Reads users/{uid}/assessment/current and restores the form.
// // //  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function loadAssessmentData(uid) {
// //   let data = null;

// //   if (uid) {
// //     try {
// //       const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
// //       if (snap.exists()) {
// //         data = snap.data();
// //         console.info("[NP Firebase] Assessment loaded from Firestore.");
// //       }
// //     } catch (err) {
// //       console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
// //     }
// //   }

// //   // Fall back to localStorage draft
// //   if (!data) {
// //     try {
// //       const raw = localStorage.getItem("nutriplan_ls_draft");
// //       if (raw) data = JSON.parse(raw);
// //       if (data) console.info("[NP Firebase] Assessment loaded from localStorage draft.");
// //     } catch (_) {}
// //   }

// //   if (!data) return; // Nothing to restore

// //   // ── Restore simple text/number/select fields ──
// //   const set = (id, val) => {
// //     const el = document.getElementById(id);
// //     if (el && val !== undefined && val !== null && val !== "") el.value = val;
// //   };

// //   set("inp-name",     data.name);
// //   set("inp-age",      data.age);
// //   set("inp-phone",    data.phone);
// //   set("inp-email",    data.email);
// //   set("inp-allergies",data.allergies);
// //   set("inp-dislikes", data.food_dislikes);
// //   set("inp-comments", data.comments);
// //   set("inp-curries",  data.num_curries);
// //   set("eat-window-val", data.eating_window);

// //   if (data.height) {
// //     set("inp-height",    data.height);
// //     set("inp-height-cm", Math.round(data.height));
// //   }
// //   set("inp-weight",   data.weight);
// //   set("inp-preg",     data.pregnancy_status);

// //   // Measurements
// //   ["waist", "neck", "hip"].forEach((m) => {
// //     const val = data[m];
// //     if (!val) return;
// //     const raw = document.getElementById(m + "-raw-input");
// //     const hid = document.getElementById("inp-" + m);
// //     if (raw) raw.value = val;
// //     if (hid) hid.value = val;
// //   });

// //   // Gender (triggers female row visibility)
// //   if (data.gender) {
// //     set("inp-gender", data.gender);
// //     const femRow = document.getElementById("female-extra-row");
// //     if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
// //   }

// //   if (data.activity_level) set("inp-activity", data.activity_level);
// //   if (data.diet_preference) set("inp-diet",     data.diet_preference);
// //   if (document.getElementById("consent-wa"))
// //     document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

// //   // ── Restore chip selections ──
// //   const restoreChips = (selector, csvString) => {
// //     if (!csvString) return;
// //     const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
// //     document.querySelectorAll(selector).forEach((chip) => {
// //       if (active.includes(chip.textContent.trim())) chip.classList.add("active");
// //     });
// //   };
// //   restoreChips("#meal-types .chip",      data.meal_types);
// //   restoreChips("#symptoms-group .chip",  data.symptoms);

// //   // Eating time chip
// //   if (data.eating_window) {
// //     document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
// //       if (tc.dataset.value === data.eating_window) tc.classList.add("active");
// //     });
// //   }

// //   // ── Restore MSDD dropdowns ──
// //   const msddMap = {
// //     "msdd-drinks":    data.morning_drinks,
// //     "msdd-fruits":    data.fruits,
// //     "msdd-veggies":   data.vegetables,
// //     "msdd-sprouts":   data.sprouts,
// //     "msdd-milkshakes":data.milkshakes,
// //     "msdd-smoothies": data.smoothies,
// //     "msdd-porridge":  data.porridge_malt,
// //     "msdd-breakfast": data.breakfast,
// //     "msdd-chutney":   data.chutney,
// //     "msdd-powders":   data.powders_ghee,
// //     "msdd-nonveg":    data.non_veg,
// //     "msdd-rice":      data.rice,
// //     "msdd-millets":   data.millets_grains,
// //   };
// //   Object.entries(msddMap).forEach(([id, csv]) => {
// //     if (!csv) return;
// //     csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
// //       const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
// //       if (cb) cb.checked = true;
// //     });
// //     if (typeof window.msddChange === "function") window.msddChange(id);
// //   });

// //   // Nuts + seeds (stored combined in "nuts_seeds")
// //   if (data.nuts_seeds) {
// //     data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
// //       ["msdd-nuts", "msdd-seeds"].forEach((id) => {
// //         const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
// //         if (cb) cb.checked = true;
// //       });
// //     });
// //     if (typeof window.msddChange === "function") {
// //       window.msddChange("msdd-nuts");
// //       window.msddChange("msdd-seeds");
// //     }
// //   }

// //   // ── Restore health conditions ──
// //   if (data.health_conditions) {
// //     const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
// //     conds.forEach((v) => {
// //       if (window.selectedConditions) window.selectedConditions.add(v);
// //       const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
// //       if (cb) cb.checked = true;
// //     });
// //     if (typeof window.renderTags === "function") window.renderTags();
// //   }

// //   // Open hidden sections that were visible
// //   ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
// //     setTimeout(() => {
// //       const el = document.getElementById(id);
// //       if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
// //     }, i * 100);
// //   });

// //   console.info("[NP Firebase] Form restored from saved data.");
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveLocalStorageDraft()
// // //  Writes a lightweight draft to localStorage for users who skip sign-in.
// // //  Called by autoSaveAssessment() when not signed in.
// // // ════════════════════════════════════════════════════════════════════════════

// // function saveLocalStorageDraft() {
// //   try {
// //     const data = collectFormData();
// //     localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
// //   } catch (err) {
// //     console.warn("[NP Firebase] localStorage backup error:", err);
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  AUTO-SAVE LOGIC
// // //  When signed in: debounce-saves to Firestore after 5 s of inactivity.
// // //  When not signed in: saves to localStorage after 3 s of inactivity.
// // //  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// // // ════════════════════════════════════════════════════════════════════════════

// // let _autoSaveTimer   = null;
// // let _autoSaveEnabled = false;

// // /** Trigger a debounced auto-save. Call this from form input listeners. */
// // function scheduleAutoSave() {
// //   if (!_autoSaveEnabled) return;
// //   clearTimeout(_autoSaveTimer);

// //   const user = auth.currentUser;
// //   const delay = user ? 5000 : 3000;

// //   _autoSaveTimer = setTimeout(async () => {
// //     if (auth.currentUser) {
// //       // Auto-save to Firestore
// //       await saveAssessmentData(auth.currentUser.uid);
// //     } else {
// //       // Auto-save to localStorage
// //       saveLocalStorageDraft();
// //     }
// //   }, delay);
// // }

// // /** Start auto-save listeners on all form inputs. */
// // function autoSaveAssessment() {
// //   _autoSaveEnabled = true;

// //   const attach = () => {
// //     document.querySelectorAll("input, select, textarea").forEach((el) => {
// //       if (!el.dataset._npAutoSave) {
// //         el.dataset._npAutoSave = "1";
// //         el.addEventListener("input",  scheduleAutoSave);
// //         el.addEventListener("change", scheduleAutoSave);
// //       }
// //     });
// //     // Chips and toggle buttons
// //     document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
// //       if (!el.dataset._npAutoSave) {
// //         el.dataset._npAutoSave = "1";
// //         el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
// //       }
// //     });
// //   };

// //   attach();
// //   // Re-attach after any dynamically rendered chips
// //   new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

// //   console.info("[NP Firebase] Auto-save enabled.");
// // }

// // /** Pause auto-save (e.g. while a modal is open or after final submission). */
// // function stopAutoSave() {
// //   _autoSaveEnabled = false;
// //   clearTimeout(_autoSaveTimer);
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  createAccount(email, password)
// // //  Creates a new Firebase Auth user and saves assessment data.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function createAccount(email, password) {
// //   // Validate inputs
// //   if (!email || !/\S+@\S+\.\S+/.test(email))
// //     return { ok: false, error: "Enter a valid email address." };
// //   if (password.length < 6)
// //     return { ok: false, error: "Password must be at least 6 characters." };

// //   // Check server-side gates
// //   const regOpen = await checkRegistrationOpen();
// //   if (!regOpen)
// //     return { ok: false, error: "New registrations are currently closed." };

// //   const allowed = await checkUserNotRestricted(email);
// //   if (!allowed)
// //     return { ok: false, error: "This email address is not allowed to register." };

// //   try {
// //     // Create Firebase Auth account
// //     const cred = await createUserWithEmailAndPassword(auth, email, password);
// //     const uid  = cred.user.uid;

// //     // Persist account metadata
// //     await setDoc(
// //       doc(db, "accounts", uid),
// //       { email, createdAt: serverTimestamp() }
// //     );

// //     // Save all pending assessment data to Firestore
// //     if (window._pendingFormData) {
// //       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
// //     }
// //     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

// //     // Store session hints
// //     localStorage.setItem("nutriplan_uid",   uid);
// //     localStorage.setItem("nutriplan_email", email);
// //     // Remove localStorage draft — it's now in Firestore
// //     localStorage.removeItem("nutriplan_ls_draft");

// //     console.info("[NP Firebase] Account created:", email, uid);
// //     return { ok: true, uid, email };
// //   } catch (err) {
// //     console.error("[NP Firebase] createAccount error:", err.code, err.message);
// //     return { ok: false, error: friendlyAuthError(err.code) };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  loginUser(email, password)
// // //  Signs the user in and saves any pending assessment data.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function loginUser(email, password) {
// //   if (!email || !/\S+@\S+\.\S+/.test(email))
// //     return { ok: false, error: "Enter a valid email address." };
// //   if (!password)
// //     return { ok: false, error: "Enter your password." };

// //   const allowed = await checkUserNotRestricted(email);
// //   if (!allowed)
// //     return { ok: false, error: "This account has been restricted." };

// //   try {
// //     const cred = await signInWithEmailAndPassword(auth, email, password);
// //     const uid  = cred.user.uid;

// //     // Save pending assessment data
// //     if (window._pendingFormData) {
// //       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
// //     }
// //     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

// //     localStorage.setItem("nutriplan_uid",   uid);
// //     localStorage.setItem("nutriplan_email", email);
// //     localStorage.removeItem("nutriplan_ls_draft");

// //     console.info("[NP Firebase] Signed in:", email, uid);
// //     return { ok: true, uid, email };
// //   } catch (err) {
// //     console.error("[NP Firebase] loginUser error:", err.code, err.message);
// //     return { ok: false, error: friendlyAuthError(err.code) };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  logoutUser()
// // //  Signs out of Firebase Auth and clears session hints.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function logoutUser() {
// //   try {
// //     stopAutoSave();
// //     await fbSignOut(auth);

// //     localStorage.removeItem("nutriplan_uid");
// //     localStorage.removeItem("nutriplan_email");
// //     localStorage.removeItem("np_auth");

// //     console.info("[NP Firebase] Signed out.");
// //     return { ok: true };
// //   } catch (err) {
// //     console.error("[NP Firebase] logoutUser error:", err.message);
// //     return { ok: false, error: err.message };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
// // //  Mirrors a submission to the "submissions" collection used by admin tools.
// // //  Preserved 100% from the original firebase module so nothing breaks.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
// //   try {
// //     const isEdit = !!(formData._editUid);
// //     let resolvedUid = accountUid || null;
// //     if (isEdit) {
// //       try {
// //         const snap = await getDoc(doc(db, "submissions", formData.userId));
// //         if (snap.exists() && snap.data().accountUid)
// //           resolvedUid = snap.data().accountUid;
// //       } catch (_) {}
// //     }
// //     const entry = {
// //       ...formData,
// //       accountUid: resolvedUid,
// //       forSelf:    forSelf !== false,
// //       relName:    relName  || "",
// //       relation:   relation || "",
// //       ...(isEdit
// //         ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
// //         : { createdAt: serverTimestamp() }),
// //     };
// //     delete entry._editUid;
// //     await setDoc(
// //       doc(db, "submissions", formData.userId),
// //       entry,
// //       isEdit ? { merge: false } : {}
// //     );
// //     if (resolvedUid) {
// //       await setDoc(
// //         doc(db, "accounts", resolvedUid, "profiles", formData.userId),
// //         {
// //           userId:    formData.userId,
// //           name:      formData.name,
// //           forSelf:   entry.forSelf,
// //           relName:   entry.relName,
// //           relation:  entry.relation,
// //           timestamp: formData.timestamp,
// //         }
// //       );
// //     }
// //   } catch (err) {
// //     console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
// //   }
// // }

// // // Expose legacy function under original name so existing inline code still works
// // window.saveToFirestore = saveToFirestoreLegacy;


// // // ════════════════════════════════════════════════════════════════════════════
// // //  onAuthStateChanged — central auth observer
// // //  • Signed in  → show avatar with initials, preload saved form data
// // //  • Signed out → show "Sign In" button, try loading localStorage draft
// // // ════════════════════════════════════════════════════════════════════════════

// // onAuthStateChanged(auth, async (user) => {
// //   const profileBtn = document.getElementById("nav-profile-btn");
// //   const signinBtn  = document.getElementById("nav-signin-btn");
// //   const step0Block = document.getElementById("step0-block");

// //   if (user) {
// //     // Restriction check
// //     const allowed = await checkUserNotRestricted(user.email || "");
// //     if (!allowed) {
// //       await fbSignOut(auth);
// //       localStorage.removeItem("np_auth");
// //       if (profileBtn) profileBtn.classList.remove("show");
// //       if (signinBtn)  signinBtn.classList.add("show");
// //       return;
// //     }

// //     // Show avatar with email initial
// //     if (profileBtn) {
// //       const initial = (user.email || "U")[0].toUpperCase();
// //       profileBtn.textContent = initial;
// //       profileBtn.classList.add("show");
// //     }
// //     if (signinBtn) signinBtn.classList.remove("show");

// //     // Start auto-save now that the user is authenticated
// //     autoSaveAssessment();

// //     // Pre-load any previously saved assessment data into the form
// //     // (only if no session draft is present, to avoid overwriting a fresh session)
// //     const hasSessionDraft = !!sessionStorage.getItem("nutriplan_draft");
// //     if (!hasSessionDraft) {
// //       await loadAssessmentData(user.uid);
// //     }

// //   } else {
// //     // Not signed in
// //     localStorage.removeItem("np_auth");
// //     if (profileBtn) profileBtn.classList.remove("show");
// //     if (signinBtn)  signinBtn.classList.add("show");
// //     if (step0Block) step0Block.style.display = "none";

// //     // Still start auto-save so localStorage draft stays fresh
// //     autoSaveAssessment();
// //   }
// // });


// // // ════════════════════════════════════════════════════════════════════════════
// // //  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
// // //  Re-uses the exact same logic from the original firebase module.
// // // ════════════════════════════════════════════════════════════════════════════

// // window._regClosed = true;

// // onSnapshot(doc(db, "settings", "global"), (snap) => {
// //   if (snap.exists()) {
// //     const data        = snap.data();
// //     const formClosed  = !!data.formSubmissionClosed;
// //     const regClosed   = !!data.registrationClosed;

// //     if (typeof window.applyFormClosedState === "function")
// //       window.applyFormClosedState(formClosed);

// //     window._regClosed = regClosed;

// //     // Keep modal tabs in sync if modal is open
// //     const modal = document.getElementById("accountModal");
// //     if (modal && modal.style.display === "flex") {
// //       if (regClosed) {
// //         if (typeof window.applyModalRegClosedState === "function")
// //           window.applyModalRegClosedState();
// //       } else {
// //         ["create", "login"].forEach((t) => {
// //           const tab = document.getElementById("tab-" + t);
// //           if (tab) {
// //             tab.classList.remove("active");
// //             tab.style.opacity = "";
// //             tab.style.cursor  = "";
// //             tab.style.pointerEvents = "";
// //             tab.title = "";
// //           }
// //         });
// //         document.getElementById("tab-create")?.classList.add("active");
// //         const authCreate = document.getElementById("auth-create");
// //         const authLogin  = document.getElementById("auth-login");
// //         if (authCreate) authCreate.style.display = "block";
// //         if (authLogin)  authLogin.style.display  = "none";
// //         const notice = document.getElementById("modal-reg-closed-notice");
// //         if (notice) notice.style.display = "none";
// //       }
// //     }
// //   } else {
// //     if (typeof window.applyFormClosedState === "function")
// //       window.applyFormClosedState(false);
// //     window._regClosed = false;
// //   }
// // }, (err) => {
// //   // "Missing or insufficient permissions" is expected when the user is signed out
// //   // and Firestore rules require auth for this document.
// //   // Fix: set `allow read: if true` on settings/global in your Firestore rules.
// //   // We only log unexpected errors (not permission denials).
// //   if (err.code !== 'permission-denied') {
// //     console.warn("[NP Firebase] settings read error:", err.code, err.message);
// //   }
// // });


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PASSWORD RESET
// // //  Exposed globally so the existing forgotModal can call it.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.doResetPassword = async function () {
// //   const email = document.getElementById("fp-email")?.value?.trim();
// //   const errEl = document.getElementById("fp-err");
// //   const sucEl = document.getElementById("fp-suc");
// //   if (errEl) errEl.style.display = "none";
// //   if (sucEl) sucEl.style.display = "none";

// //   if (!email || !/\S+@\S+\.\S+/.test(email)) {
// //     if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
// //     return;
// //   }
// //   try {
// //     await sendPasswordResetEmail(auth, email);
// //     if (sucEl) {
// //       sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
// //       sucEl.style.display = "block";
// //     }
// //     setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
// //   } catch (err) {
// //     if (errEl) {
// //       errEl.textContent = err.code === "auth/user-not-found"
// //         ? "No account found with this email."
// //         : friendlyAuthError(err.code);
// //       errEl.style.display = "block";
// //     }
// //   }
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
// // //  These override the window.createAccount and window.signInExisting
// // //  originally defined inline in onboarding.html.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.createAccount = async function () {
// //   const errEl = document.getElementById("acct-err");
// //   if (errEl) errEl.style.display = "none";

// //   if (window._regClosed) {
// //     if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
// //     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
// //     return;
// //   }

// //   const email = document.getElementById("acct-email")?.value?.trim() ?? "";
// //   const pass  = document.getElementById("acct-pass")?.value  ?? "";
// //   const pass2 = document.getElementById("acct-pass2")?.value ?? "";

// //   if (pass !== pass2) {
// //     if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Disable button while working
// //   const btn = document.querySelector("#auth-create .btn-primary");
// //   if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

// //   const result = await createAccount(email, pass);

// //   if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

// //   if (!result.ok) {
// //     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Success — store local profile reference and redirect
// //   if (window._pendingFormData) {
// //     if (typeof window.saveLocalProfile === "function")
// //       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
// //         window._isForSelf, window._relName, window._relation);
// //   }
// //   window.location.href = "dietplan.html";
// // };


// // window.signInExisting = async function () {
// //   const errEl = document.getElementById("login-err");
// //   if (errEl) errEl.style.display = "none";

// //   const email = document.getElementById("login-email")?.value?.trim() ?? "";
// //   const pass  = document.getElementById("login-pass")?.value ?? "";

// //   const btn = document.querySelector("#auth-login .btn-primary");
// //   if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

// //   const result = await loginUser(email, pass);

// //   if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

// //   if (!result.ok) {
// //     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Success — store local profile reference and redirect
// //   if (window._pendingFormData) {
// //     if (typeof window.saveLocalProfile === "function")
// //       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
// //         window._isForSelf, window._relName, window._relation);
// //   }
// //   window.location.href = "dietplan.html";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  SIGN OUT (called by avatar dropdown)
// // //  Replaces the doSignOut() function defined in the non-module <script>.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.doSignOut = async function () {
// //   const result = await logoutUser();
// //   if (result.ok) {
// //     document.getElementById("nav-profile-btn")?.classList.remove("show");
// //     const signinBtn = document.getElementById("nav-signin-btn");
// //     if (signinBtn) signinBtn.classList.add("show");
// //     document.getElementById("avatar-dropdown")?.classList.remove("open");
// //     window.location.href = "index.html";
// //   } else {
// //     localStorage.removeItem("np_auth");
// //     window.location.reload();
// //   }
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  UNREAD MESSAGES CHECK (unchanged from original)
// // // ════════════════════════════════════════════════════════════════════════════

// // async function checkUnreadMessages(uid) {
// //   try {
// //     const { collection: col, getDocs: gd, query: q, where: w } =
// //       await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
// //     const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
// //     if (!snap.empty) {
// //       const dot = document.getElementById("nav-msg-dot");
// //       if (dot) dot.style.display = "inline-block";
// //     }
// //   } catch (_) {}
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PASSWORD VISIBILITY TOGGLE
// // // ════════════════════════════════════════════════════════════════════════════

// // window.togglePw = function (inputId, btn) {
// //   const inp = document.getElementById(inputId);
// //   if (!inp) return;
// //   const isText = inp.type === "text";
// //   inp.type  = isText ? "password" : "text";
// //   btn.textContent = isText ? "👁" : "🙈";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  ACCOUNT MODAL HELPERS (unchanged from original)
// // // ════════════════════════════════════════════════════════════════════════════

// // window.proceedToAuth = function () {
// //   document.getElementById("acct-step-save").style.display = "none";
// //   const user = auth.currentUser;
// //   if (user) {
// //     (async () => {
// //       await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
// //       await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
// //       if (typeof window.saveLocalProfile === "function")
// //         window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
// //       const isEdit = !!window._pendingFormData?._editUid;
// //       if (typeof window.showAccountDone === "function")
// //         window.showAccountDone(
// //           "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
// //           isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
// //         );
// //     })();
// //   } else {
// //     const authStep = document.getElementById("acct-step-auth");
// //     if (authStep) authStep.style.display = "block";
// //   }
// // };

// // window.switchAuthTab = function (tab) {
// //   if (tab === "create" && window._regClosed) {
// //     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
// //     return;
// //   }
// //   ["create", "login"].forEach((t) => {
// //     document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
// //   });
// //   const authCreate = document.getElementById("auth-create");
// //   const authLogin  = document.getElementById("auth-login");
// //   if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
// //   if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
// // };

// // window.skipAccount = function () { window.closeAccountModal(); };
// // window.closeAccountModal = function () {
// //   const m = document.getElementById("accountModal");
// //   if (m) m.style.display = "none";
// //   // Save to localStorage as backup since user skipped sign-in
// //   saveLocalStorageDraft();
// // };

// // window.openAccountModal = function (formData) {
// //   window._pendingFormData = formData;
// //   window._isForSelf  = window._planForSelf   !== false;
// //   window._relName    = window._planOtherName  || "";
// //   window._relation   = window._planOtherRelation || "";
// //   document.getElementById("acct-step-save").style.display  = "block";
// //   document.getElementById("acct-step-auth").style.display  = "none";
// //   document.getElementById("acct-step-done").style.display  = "none";
// //   const m = document.getElementById("accountModal");
// //   if (m) m.style.display = "flex";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PUBLIC API — exposed on window.NP_FB for external scripts
// // // ════════════════════════════════════════════════════════════════════════════

// // window.NP_FB = {
// //   auth,
// //   db,
// //   createAccount,
// //   loginUser,
// //   logoutUser,
// //   saveAssessmentData,
// //   loadAssessmentData,
// //   autoSaveAssessment,
// //   stopAutoSave,
// //   saveLocalStorageDraft,
// //   collectFormData,
// // };

// // // Also expose the firebase instances directly (backwards compat)
// // window.auth = auth;
// // window.db   = db;









// // /**
// //  * ═══════════════════════════════════════════════════════════════
// //  *  firebase.js  —  NutriPlan Firebase Integration Module
// //  *  All Firebase Auth + Firestore logic lives here.
// //  *  Imported by onboarding.html as a ES module script.
// //  * ═══════════════════════════════════════════════════════════════
// //  *
// //  *  EXPORTS (attached to window for non-module scripts to call):
// //  *    window.NP_FB = {
// //  *      auth, db,
// //  *      createAccount(), loginUser(), logoutUser(),
// //  *      saveAssessmentData(), loadAssessmentData(),
// //  *      autoSaveAssessment(), stopAutoSave()
// //  *    }
// //  *
// //  *  AUTH FLOW:
// //  *    1. On page load  → onAuthStateChanged fires
// //  *       • Signed in   → show avatar, preload saved data into form
// //  *       • Signed out  → show "Sign In" button, try restoring localStorage draft
// //  *
// //  *    2. On form submit (submitForm) in onboarding.html:
// //  *       • If user NOT signed in → openAccountModal() is called
// //  *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
// //  *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
// //  *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
// //  *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
// //  *       • If user IS signed in  → saveAssessmentData() called immediately
// //  *
// //  *  SAVING FLOW (saveAssessmentData):
// //  *    Reads all form fields + calculated metrics into one flat object.
// //  *    Writes to THREE Firestore paths under the authenticated user's UID:
// //  *      • users/{uid}/profile          — name, email, phone, basic info
// //  *      • users/{uid}/assessment/current — all assessment fields + calculated data
// //  *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
// //  *    Also mirrors full submission to the legacy "submissions/{userId}" path
// //  *    so admin tools continue to work unchanged.
// //  *
// //  *  LOADING FLOW (loadAssessmentData):
// //  *    Reads users/{uid}/assessment/current from Firestore.
// //  *    Restores every form field, chip selections, MSDD dropdowns, etc.
// //  *    Falls back to localStorage draft if Firestore has no saved data.
// //  *
// //  *  AUTO-SAVE LOGIC:
// //  *    When a user is signed in, we start a 5-second debounce interval.
// //  *    Any form interaction resets the timer. After 5 s of inactivity the
// //  *    draft is persisted to Firestore (users/{uid}/assessment/current).
// //  *    Auto-save is stopped when the modal is open or the form is submitted.
// //  *
// //  *  LOCALSTORAGE BACKUP:
// //  *    When a user skips account creation OR is not signed in, the draft is
// //  *    written to localStorage under "nutriplan_ls_draft".
// //  *    On page reload, loadAssessmentData() restores it if no Firestore data
// //  *    is available.
// //  */

// // // ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
// // import { initializeApp }
// //   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// // import {
// //   getAuth,
// //   createUserWithEmailAndPassword,
// //   signInWithEmailAndPassword,
// //   signOut as fbSignOut,
// //   onAuthStateChanged,
// //   sendPasswordResetEmail,
// // } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// // import {
// //   getFirestore,
// //   doc,
// //   getDoc,
// //   setDoc,
// //   collection,
// //   serverTimestamp,
// //   onSnapshot,
// // } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// // // ── Firebase project config ──────────────────────────────────────────────────
// // const firebaseConfig = {
// //   apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
// //   authDomain:        "nutriplan-65582.firebaseapp.com",
// //   projectId:         "nutriplan-65582",
// //   storageBucket:     "nutriplan-65582.firebasestorage.app",
// //   messagingSenderId: "851509980462",
// //   appId:             "1:851509980462:web:b18af741addba334ca1ebf",
// //   measurementId:     "G-2XZZ9YW5FJ",
// // };

// // // ── Initialise Firebase ───────────────────────────────────────────────────────
// // const app  = initializeApp(firebaseConfig);
// // const auth = getAuth(app);
// // const db   = getFirestore(app);

// // // Expose auth + db to window so legacy inline scripts can reference them
// // window._fbAuth = auth;
// // window._fbDb   = db;


// // // ════════════════════════════════════════════════════════════════════════════
// // //  HELPERS
// // // ════════════════════════════════════════════════════════════════════════════

// // /** Map Firebase auth error codes to user-friendly messages. */
// // function friendlyAuthError(code) {
// //   const map = {
// //     "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
// //     "auth/invalid-email":          "Please enter a valid email address.",
// //     "auth/weak-password":          "Password is too weak — minimum 6 characters.",
// //     "auth/user-not-found":         "No account found with that email.",
// //     "auth/wrong-password":         "Incorrect password. Please try again.",
// //     "auth/invalid-credential":     "Incorrect email or password.",
// //     "auth/network-request-failed": "Network error — please check your connection and try again.",
// //     "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
// //   };
// //   return map[code] || "Authentication error. Please try again.";
// // }

// // /** Check whether a Firestore "restrictedUsers" doc exists for this email. */
// // async function checkUserNotRestricted(email) {
// //   const docId = email.toLowerCase().replace(/[@.]/g, "_");
// //   try {
// //     const snap = await getDoc(doc(db, "restrictedUsers", docId));
// //     if (snap.exists()) return false;
// //   } catch (_) {}
// //   return true;
// // }

// // /** Check whether the global settings allow new registrations. */
// // async function checkRegistrationOpen() {
// //   try {
// //     const snap = await getDoc(doc(db, "settings", "global"));
// //     if (snap.exists() && snap.data().registrationClosed === true) return false;
// //   } catch (err) {
// //     // permission-denied means the rules block unauthenticated reads on settings/global
// //     // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
// //     if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
// //   }
// //   return true;
// // }

// // /** Safely read a DOM element value. */
// // const gv = (id) => document.getElementById(id)?.value ?? "";

// // /** Read all active chip texts from a CSS selector. */
// // const activeChips = (sel) =>
// //   [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// // // ════════════════════════════════════════════════════════════════════════════
// // //  COLLECT FORM DATA
// // //  Reads every field on the assessment form into a plain JS object.
// // //  Called by saveAssessmentData() and the legacy submitForm().
// // // ════════════════════════════════════════════════════════════════════════════

// // function collectFormData() {
// //   // msddState is defined in the main onboarding.html script
// //   const msd = (key) => ((window.msddState || {})[key] || []).join(", ");

// //   return {
// //     // ── Personal details ──
// //     name:             gv("inp-name").trim(),
// //     age:              gv("inp-age"),
// //     gender:           gv("inp-gender"),
// //     phone:            gv("inp-phone"),
// //     email:            gv("inp-email"),

// //     // ── Body metrics ──
// //     height:           gv("inp-height"),
// //     weight:           gv("inp-weight"),
// //     waist:            gv("inp-waist"),
// //     neck:             gv("inp-neck"),
// //     hip:              gv("inp-hip"),
// //     pregnancy_status: gv("inp-preg"),
// //     activity_level:   gv("inp-activity"),

// //     // ── Calculated metrics (from _lastCalcData on window) ──
// //     // Note: _lastCalcData stores {wt, ht, ...} but not bmi/bfp directly — recompute
// //     bmi: (() => {
// //       const d = window._lastCalcData;
// //       if (!d) return "";
// //       return (d.wt / ((d.ht/100) ** 2)).toFixed(1);
// //     })(),
// //     bmi_category: (() => {
// //       const d = window._lastCalcData;
// //       if (!d) return "";
// //       const b = d.wt / ((d.ht/100) ** 2);
// //       return b < 18.5 ? "Underweight" : b < 25 ? "Normal weight" : b < 30 ? "Overweight" : "Obese";
// //     })(),
// //     body_fat: "",  // recomputed in submitForm from live inputs; not stored in _lastCalcData
// //     ideal_weight:         window._lastCalcData?.idealWeight?.toFixed?.(1) ?? "",
// //     bmr:                  window._lastCalcData ? Math.round(window._lastCalcData.bmr) : "",
// //     maintenance_calories: window._lastCalcData?.maintenance ?? "",
// //     goal_direction:       window._lastCalcData?.direction    ?? "",
// //     goal_calories: (() => {
// //       const d = window._lastCalcData;
// //       if (!d) return "";
// //       const rate = window._currentGoalRate ?? 0.5;
// //       const adj  = rate === 0.25 ? 250 : rate === 1 ? 1000 : 500;
// //       return String(d.direction === "loss"
// //         ? Math.max(1000, d.maintenance - adj)
// //         : d.direction === "gain"
// //         ? d.maintenance + adj
// //         : d.maintenance);
// //     })(),

// //     // ── Health conditions ──
// //     health_conditions: [...(window.selectedConditions ?? new Set())].join(", "),
// //     allergies:         gv("inp-allergies"),

// //     // ── Diet preferences ──
// //     diet_preference: gv("inp-diet"),
// //     meal_types:      activeChips("#meal-types .chip").join(", "),
// //     eating_window:   gv("eat-window-val"),
// //     num_curries:     gv("inp-curries"),

// //     // ── Food preferences (MSDD dropdowns) ──
// //     morning_drinks:  msd("msdd-drinks"),
// //     nuts_seeds:      [...((window.msddState || {})["msdd-nuts"]  || []),
// //                       ...((window.msddState || {})["msdd-seeds"] || [])].join(", "),
// //     fruits:          msd("msdd-fruits"),
// //     vegetables:      msd("msdd-veggies"),
// //     sprouts:         msd("msdd-sprouts"),
// //     milkshakes:      msd("msdd-milkshakes"),
// //     smoothies:       msd("msdd-smoothies"),
// //     porridge_malt:   msd("msdd-porridge"),
// //     breakfast:       msd("msdd-breakfast"),
// //     chutney:         msd("msdd-chutney"),
// //     powders_ghee:    msd("msdd-powders"),
// //     non_veg:         msd("msdd-nonveg"),
// //     rice:            msd("msdd-rice"),
// //     millets_grains:  msd("msdd-millets"),

// //     // ── Symptoms & comments ──
// //     symptoms:         activeChips("#symptoms-group .chip").join(", "),
// //     comments:         gv("inp-comments"),
// //     food_dislikes:    gv("inp-dislikes"),
// //     whatsapp_consent: document.getElementById("consent-wa")?.checked ? "Yes" : "No",
// //   };
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveAssessmentData(uid)
// // //  Writes all assessment fields + metadata to Firestore under the user's UID.
// // //
// // //  Firestore structure:
// // //    users/{uid}/profile          — name, email, phone
// // //    users/{uid}/assessment/current — full assessment snapshot
// // //    users/{uid}/progress         — goals, BMI, body fat, timestamps
// // //
// // //  Also writes to legacy submissions/{submissionId} for admin compatibility.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function saveAssessmentData(uid, submissionId) {
// //   if (!uid) {
// //     console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
// //     return;
// //   }

// //   const data = collectFormData();
// //   const now  = serverTimestamp();

// //   try {
// //     // 1. Profile document (quick lookup fields)
// //     await setDoc(
// //       doc(db, "users", uid, "profile", "info"),
// //       {
// //         name:      data.name,
// //         email:     data.email || auth.currentUser?.email || "",
// //         phone:     data.phone,
// //         updatedAt: now,
// //       },
// //       { merge: true }
// //     );

// //     // 2. Full assessment snapshot (overwrites on each save)
// //     await setDoc(
// //       doc(db, "users", uid, "assessment", "current"),
// //       {
// //         ...data,
// //         uid,
// //         submissionId: submissionId || "",
// //         savedAt: now,
// //       }
// //     );

// //     // 3. Progress / goal metrics document
// //     await setDoc(
// //       doc(db, "users", uid, "progress", "latest"),
// //       {
// //         bmi:              data.bmi,
// //         bmi_category:     data.bmi_category,
// //         body_fat:         data.body_fat,
// //         ideal_weight:     data.ideal_weight,
// //         goal_direction:   data.goal_direction,
// //         goal_calories:    data.goal_calories,
// //         maintenance_calories: data.maintenance_calories,
// //         bmr:              data.bmr,
// //         recordedAt:       now,
// //       },
// //       { merge: true }
// //     );

// //     console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
// //   } catch (err) {
// //     console.error("[NP Firebase] saveAssessmentData error:", err);
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  loadAssessmentData(uid)
// // //  Reads users/{uid}/assessment/current and restores the form.
// // //  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function loadAssessmentData(uid) {
// //   let data = null;

// //   if (uid) {
// //     try {
// //       const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
// //       if (snap.exists()) {
// //         data = snap.data();
// //         console.info("[NP Firebase] Assessment loaded from Firestore.");
// //       }
// //     } catch (err) {
// //       console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
// //     }
// //   }

// //   // Fall back to localStorage draft
// //   if (!data) {
// //     try {
// //       const raw = localStorage.getItem("nutriplan_ls_draft");
// //       if (raw) data = JSON.parse(raw);
// //       if (data) console.info("[NP Firebase] Assessment loaded from localStorage draft.");
// //     } catch (_) {}
// //   }

// //   if (!data) return; // Nothing to restore

// //   // ── Restore simple text/number/select fields ──
// //   const set = (id, val) => {
// //     const el = document.getElementById(id);
// //     if (el && val !== undefined && val !== null && val !== "") el.value = val;
// //   };

// //   set("inp-name",     data.name);
// //   set("inp-age",      data.age);
// //   set("inp-phone",    data.phone);
// //   set("inp-email",    data.email);
// //   set("inp-allergies",data.allergies);
// //   set("inp-dislikes", data.food_dislikes);
// //   set("inp-comments", data.comments);
// //   set("inp-curries",  data.num_curries);
// //   set("eat-window-val", data.eating_window);

// //   if (data.height) {
// //     set("inp-height",    data.height);
// //     set("inp-height-cm", Math.round(data.height));
// //   }
// //   set("inp-weight",   data.weight);
// //   set("inp-preg",     data.pregnancy_status);

// //   // Measurements
// //   ["waist", "neck", "hip"].forEach((m) => {
// //     const val = data[m];
// //     if (!val) return;
// //     const raw = document.getElementById(m + "-raw-input");
// //     const hid = document.getElementById("inp-" + m);
// //     if (raw) raw.value = val;
// //     if (hid) hid.value = val;
// //   });

// //   // Gender (triggers female row visibility)
// //   if (data.gender) {
// //     set("inp-gender", data.gender);
// //     const femRow = document.getElementById("female-extra-row");
// //     if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
// //   }

// //   if (data.activity_level) set("inp-activity", data.activity_level);
// //   if (data.diet_preference) set("inp-diet",     data.diet_preference);
// //   if (document.getElementById("consent-wa"))
// //     document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

// //   // ── Restore chip selections ──
// //   const restoreChips = (selector, csvString) => {
// //     if (!csvString) return;
// //     const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
// //     document.querySelectorAll(selector).forEach((chip) => {
// //       if (active.includes(chip.textContent.trim())) chip.classList.add("active");
// //     });
// //   };
// //   restoreChips("#meal-types .chip",      data.meal_types);
// //   restoreChips("#symptoms-group .chip",  data.symptoms);

// //   // Eating time chip
// //   if (data.eating_window) {
// //     document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
// //       if (tc.dataset.value === data.eating_window) tc.classList.add("active");
// //     });
// //   }

// //   // ── Restore MSDD dropdowns ──
// //   const msddMap = {
// //     "msdd-drinks":    data.morning_drinks,
// //     "msdd-fruits":    data.fruits,
// //     "msdd-veggies":   data.vegetables,
// //     "msdd-sprouts":   data.sprouts,
// //     "msdd-milkshakes":data.milkshakes,
// //     "msdd-smoothies": data.smoothies,
// //     "msdd-porridge":  data.porridge_malt,
// //     "msdd-breakfast": data.breakfast,
// //     "msdd-chutney":   data.chutney,
// //     "msdd-powders":   data.powders_ghee,
// //     "msdd-nonveg":    data.non_veg,
// //     "msdd-rice":      data.rice,
// //     "msdd-millets":   data.millets_grains,
// //   };
// //   Object.entries(msddMap).forEach(([id, csv]) => {
// //     if (!csv) return;
// //     csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
// //       const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
// //       if (cb) cb.checked = true;
// //     });
// //     if (typeof window.msddChange === "function") window.msddChange(id);
// //   });

// //   // Nuts + seeds (stored combined in "nuts_seeds")
// //   if (data.nuts_seeds) {
// //     data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
// //       ["msdd-nuts", "msdd-seeds"].forEach((id) => {
// //         const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
// //         if (cb) cb.checked = true;
// //       });
// //     });
// //     if (typeof window.msddChange === "function") {
// //       window.msddChange("msdd-nuts");
// //       window.msddChange("msdd-seeds");
// //     }
// //   }

// //   // ── Restore health conditions ──
// //   if (data.health_conditions) {
// //     const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
// //     conds.forEach((v) => {
// //       if (window.selectedConditions) window.selectedConditions.add(v);
// //       const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
// //       if (cb) cb.checked = true;
// //     });
// //     if (typeof window.renderTags === "function") window.renderTags();
// //   }

// //   // Open hidden sections that were visible
// //   ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
// //     setTimeout(() => {
// //       const el = document.getElementById(id);
// //       if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
// //     }, i * 100);
// //   });

// //   console.info("[NP Firebase] Form restored from saved data.");
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveLocalStorageDraft()
// // //  Writes a lightweight draft to localStorage for users who skip sign-in.
// // //  Called by autoSaveAssessment() when not signed in.
// // // ════════════════════════════════════════════════════════════════════════════

// // function saveLocalStorageDraft() {
// //   try {
// //     const data = collectFormData();
// //     localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
// //   } catch (err) {
// //     console.warn("[NP Firebase] localStorage backup error:", err);
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  AUTO-SAVE LOGIC
// // //  When signed in: debounce-saves to Firestore after 5 s of inactivity.
// // //  When not signed in: saves to localStorage after 3 s of inactivity.
// // //  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// // // ════════════════════════════════════════════════════════════════════════════

// // let _autoSaveTimer   = null;
// // let _autoSaveEnabled = false;

// // /** Trigger a debounced auto-save. Call this from form input listeners. */
// // function scheduleAutoSave() {
// //   if (!_autoSaveEnabled) return;
// //   clearTimeout(_autoSaveTimer);

// //   const user = auth.currentUser;
// //   const delay = user ? 5000 : 3000;

// //   _autoSaveTimer = setTimeout(async () => {
// //     if (auth.currentUser) {
// //       // Auto-save to Firestore
// //       await saveAssessmentData(auth.currentUser.uid);
// //     } else {
// //       // Auto-save to localStorage
// //       saveLocalStorageDraft();
// //     }
// //   }, delay);
// // }

// // /** Start auto-save listeners on all form inputs. */
// // function autoSaveAssessment() {
// //   _autoSaveEnabled = true;

// //   const attach = () => {
// //     document.querySelectorAll("input, select, textarea").forEach((el) => {
// //       if (!el.dataset._npAutoSave) {
// //         el.dataset._npAutoSave = "1";
// //         el.addEventListener("input",  scheduleAutoSave);
// //         el.addEventListener("change", scheduleAutoSave);
// //       }
// //     });
// //     // Chips and toggle buttons
// //     document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
// //       if (!el.dataset._npAutoSave) {
// //         el.dataset._npAutoSave = "1";
// //         el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
// //       }
// //     });
// //   };

// //   attach();
// //   // Re-attach after any dynamically rendered chips
// //   new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

// //   console.info("[NP Firebase] Auto-save enabled.");
// // }

// // /** Pause auto-save (e.g. while a modal is open or after final submission). */
// // function stopAutoSave() {
// //   _autoSaveEnabled = false;
// //   clearTimeout(_autoSaveTimer);
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  createAccount(email, password)
// // //  Creates a new Firebase Auth user and saves assessment data.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function createAccount(email, password) {
// //   // Validate inputs
// //   if (!email || !/\S+@\S+\.\S+/.test(email))
// //     return { ok: false, error: "Enter a valid email address." };
// //   if (password.length < 6)
// //     return { ok: false, error: "Password must be at least 6 characters." };

// //   // Check server-side gates
// //   const regOpen = await checkRegistrationOpen();
// //   if (!regOpen)
// //     return { ok: false, error: "New registrations are currently closed." };

// //   const allowed = await checkUserNotRestricted(email);
// //   if (!allowed)
// //     return { ok: false, error: "This email address is not allowed to register." };

// //   try {
// //     // Create Firebase Auth account
// //     const cred = await createUserWithEmailAndPassword(auth, email, password);
// //     const uid  = cred.user.uid;

// //     // Persist account metadata
// //     await setDoc(
// //       doc(db, "accounts", uid),
// //       { email, createdAt: serverTimestamp() }
// //     );

// //     // Save all pending assessment data to Firestore
// //     if (window._pendingFormData) {
// //       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
// //     }
// //     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

// //     // Store session hints
// //     localStorage.setItem("nutriplan_uid",   uid);
// //     localStorage.setItem("nutriplan_email", email);
// //     // Remove localStorage draft — it's now in Firestore
// //     localStorage.removeItem("nutriplan_ls_draft");

// //     console.info("[NP Firebase] Account created:", email, uid);
// //     return { ok: true, uid, email };
// //   } catch (err) {
// //     console.error("[NP Firebase] createAccount error:", err.code, err.message);
// //     return { ok: false, error: friendlyAuthError(err.code) };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  loginUser(email, password)
// // //  Signs the user in and saves any pending assessment data.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function loginUser(email, password) {
// //   if (!email || !/\S+@\S+\.\S+/.test(email))
// //     return { ok: false, error: "Enter a valid email address." };
// //   if (!password)
// //     return { ok: false, error: "Enter your password." };

// //   const allowed = await checkUserNotRestricted(email);
// //   if (!allowed)
// //     return { ok: false, error: "This account has been restricted." };

// //   try {
// //     const cred = await signInWithEmailAndPassword(auth, email, password);
// //     const uid  = cred.user.uid;

// //     // Save pending assessment data
// //     if (window._pendingFormData) {
// //       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
// //     }
// //     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

// //     localStorage.setItem("nutriplan_uid",   uid);
// //     localStorage.setItem("nutriplan_email", email);
// //     localStorage.removeItem("nutriplan_ls_draft");

// //     console.info("[NP Firebase] Signed in:", email, uid);
// //     return { ok: true, uid, email };
// //   } catch (err) {
// //     console.error("[NP Firebase] loginUser error:", err.code, err.message);
// //     return { ok: false, error: friendlyAuthError(err.code) };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  logoutUser()
// // //  Signs out of Firebase Auth and clears session hints.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function logoutUser() {
// //   try {
// //     stopAutoSave();
// //     await fbSignOut(auth);

// //     localStorage.removeItem("nutriplan_uid");
// //     localStorage.removeItem("nutriplan_email");
// //     localStorage.removeItem("np_auth");

// //     console.info("[NP Firebase] Signed out.");
// //     return { ok: true };
// //   } catch (err) {
// //     console.error("[NP Firebase] logoutUser error:", err.message);
// //     return { ok: false, error: err.message };
// //   }
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
// // //  Mirrors a submission to the "submissions" collection used by admin tools.
// // //  Preserved 100% from the original firebase module so nothing breaks.
// // // ════════════════════════════════════════════════════════════════════════════

// // async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
// //   try {
// //     const isEdit = !!(formData._editUid);
// //     let resolvedUid = accountUid || null;
// //     if (isEdit) {
// //       try {
// //         const snap = await getDoc(doc(db, "submissions", formData.userId));
// //         if (snap.exists() && snap.data().accountUid)
// //           resolvedUid = snap.data().accountUid;
// //       } catch (_) {}
// //     }
// //     const entry = {
// //       ...formData,
// //       accountUid: resolvedUid,
// //       forSelf:    forSelf !== false,
// //       relName:    relName  || "",
// //       relation:   relation || "",
// //       ...(isEdit
// //         ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
// //         : { createdAt: serverTimestamp() }),
// //     };
// //     delete entry._editUid;
// //     await setDoc(
// //       doc(db, "submissions", formData.userId),
// //       entry,
// //       isEdit ? { merge: false } : {}
// //     );
// //     if (resolvedUid) {
// //       await setDoc(
// //         doc(db, "accounts", resolvedUid, "profiles", formData.userId),
// //         {
// //           userId:    formData.userId,
// //           name:      formData.name,
// //           forSelf:   entry.forSelf,
// //           relName:   entry.relName,
// //           relation:  entry.relation,
// //           timestamp: formData.timestamp,
// //         }
// //       );
// //     }
// //   } catch (err) {
// //     console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
// //   }
// // }

// // // Expose legacy function under original name so existing inline code still works
// // window.saveToFirestore = saveToFirestoreLegacy;


// // // ════════════════════════════════════════════════════════════════════════════
// // //  onAuthStateChanged — central auth observer
// // //  • Signed in  → show avatar with initials, preload saved form data
// // //  • Signed out → show "Sign In" button, try loading localStorage draft
// // // ════════════════════════════════════════════════════════════════════════════

// // onAuthStateChanged(auth, async (user) => {
// //   const profileBtn = document.getElementById("nav-profile-btn");
// //   const signinBtn  = document.getElementById("nav-signin-btn");
// //   const step0Block = document.getElementById("step0-block");

// //   if (user) {
// //     // Restriction check
// //     const allowed = await checkUserNotRestricted(user.email || "");
// //     if (!allowed) {
// //       await fbSignOut(auth);
// //       localStorage.removeItem("np_auth");
// //       if (profileBtn) profileBtn.classList.remove("show");
// //       if (signinBtn)  signinBtn.classList.add("show");
// //       return;
// //     }

// //     // Show avatar with email initial
// //     if (profileBtn) {
// //       const initial = (user.email || "U")[0].toUpperCase();
// //       profileBtn.textContent = initial;
// //       profileBtn.classList.add("show");
// //     }
// //     if (signinBtn) signinBtn.classList.remove("show");

// //     // Start auto-save now that the user is authenticated
// //     autoSaveAssessment();

// //     // Pre-load any previously saved assessment data into the form
// //     // (only if no session draft is present, to avoid overwriting a fresh session)
// //     const hasSessionDraft = !!sessionStorage.getItem("nutriplan_draft");
// //     if (!hasSessionDraft) {
// //       await loadAssessmentData(user.uid);
// //     }

// //   } else {
// //     // Not signed in
// //     localStorage.removeItem("np_auth");
// //     if (profileBtn) profileBtn.classList.remove("show");
// //     if (signinBtn)  signinBtn.classList.add("show");
// //     if (step0Block) step0Block.style.display = "none";

// //     // Still start auto-save so localStorage draft stays fresh
// //     autoSaveAssessment();
// //   }
// // });


// // // ════════════════════════════════════════════════════════════════════════════
// // //  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
// // //  Re-uses the exact same logic from the original firebase module.
// // // ════════════════════════════════════════════════════════════════════════════

// // window._regClosed = true;

// // onSnapshot(doc(db, "settings", "global"), (snap) => {
// //   if (snap.exists()) {
// //     const data        = snap.data();
// //     const formClosed  = !!data.formSubmissionClosed;
// //     const regClosed   = !!data.registrationClosed;

// //     if (typeof window.applyFormClosedState === "function")
// //       window.applyFormClosedState(formClosed);

// //     window._regClosed = regClosed;

// //     // Keep modal tabs in sync if modal is open
// //     const modal = document.getElementById("accountModal");
// //     if (modal && modal.style.display === "flex") {
// //       if (regClosed) {
// //         if (typeof window.applyModalRegClosedState === "function")
// //           window.applyModalRegClosedState();
// //       } else {
// //         ["create", "login"].forEach((t) => {
// //           const tab = document.getElementById("tab-" + t);
// //           if (tab) {
// //             tab.classList.remove("active");
// //             tab.style.opacity = "";
// //             tab.style.cursor  = "";
// //             tab.style.pointerEvents = "";
// //             tab.title = "";
// //           }
// //         });
// //         document.getElementById("tab-create")?.classList.add("active");
// //         const authCreate = document.getElementById("auth-create");
// //         const authLogin  = document.getElementById("auth-login");
// //         if (authCreate) authCreate.style.display = "block";
// //         if (authLogin)  authLogin.style.display  = "none";
// //         const notice = document.getElementById("modal-reg-closed-notice");
// //         if (notice) notice.style.display = "none";
// //       }
// //     }
// //   } else {
// //     if (typeof window.applyFormClosedState === "function")
// //       window.applyFormClosedState(false);
// //     window._regClosed = false;
// //   }
// // }, (err) => {
// //   // "Missing or insufficient permissions" is expected when the user is signed out
// //   // and Firestore rules require auth for this document.
// //   // Fix: set `allow read: if true` on settings/global in your Firestore rules.
// //   // We only log unexpected errors (not permission denials).
// //   if (err.code !== 'permission-denied') {
// //     console.warn("[NP Firebase] settings read error:", err.code, err.message);
// //   }
// // });


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PASSWORD RESET
// // //  Exposed globally so the existing forgotModal can call it.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.doResetPassword = async function () {
// //   const email = document.getElementById("fp-email")?.value?.trim();
// //   const errEl = document.getElementById("fp-err");
// //   const sucEl = document.getElementById("fp-suc");
// //   if (errEl) errEl.style.display = "none";
// //   if (sucEl) sucEl.style.display = "none";

// //   if (!email || !/\S+@\S+\.\S+/.test(email)) {
// //     if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
// //     return;
// //   }
// //   try {
// //     await sendPasswordResetEmail(auth, email);
// //     if (sucEl) {
// //       sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
// //       sucEl.style.display = "block";
// //     }
// //     setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
// //   } catch (err) {
// //     if (errEl) {
// //       errEl.textContent = err.code === "auth/user-not-found"
// //         ? "No account found with this email."
// //         : friendlyAuthError(err.code);
// //       errEl.style.display = "block";
// //     }
// //   }
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
// // //  These override the window.createAccount and window.signInExisting
// // //  originally defined inline in onboarding.html.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.createAccount = async function () {
// //   const errEl = document.getElementById("acct-err");
// //   if (errEl) errEl.style.display = "none";

// //   if (window._regClosed) {
// //     if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
// //     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
// //     return;
// //   }

// //   const email = document.getElementById("acct-email")?.value?.trim() ?? "";
// //   const pass  = document.getElementById("acct-pass")?.value  ?? "";
// //   const pass2 = document.getElementById("acct-pass2")?.value ?? "";

// //   if (pass !== pass2) {
// //     if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Disable button while working
// //   const btn = document.querySelector("#auth-create .btn-primary");
// //   if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

// //   const result = await createAccount(email, pass);

// //   if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

// //   if (!result.ok) {
// //     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Success — store local profile reference and redirect
// //   if (window._pendingFormData) {
// //     if (typeof window.saveLocalProfile === "function")
// //       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
// //         window._isForSelf, window._relName, window._relation);
// //   }
// //   window.location.href = "dietplan.html";
// // };


// // window.signInExisting = async function () {
// //   const errEl = document.getElementById("login-err");
// //   if (errEl) errEl.style.display = "none";

// //   const email = document.getElementById("login-email")?.value?.trim() ?? "";
// //   const pass  = document.getElementById("login-pass")?.value ?? "";

// //   const btn = document.querySelector("#auth-login .btn-primary");
// //   if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

// //   const result = await loginUser(email, pass);

// //   if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

// //   if (!result.ok) {
// //     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
// //     return;
// //   }

// //   // Success — store local profile reference and redirect
// //   if (window._pendingFormData) {
// //     if (typeof window.saveLocalProfile === "function")
// //       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
// //         window._isForSelf, window._relName, window._relation);
// //   }
// //   window.location.href = "dietplan.html";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  SIGN OUT (called by avatar dropdown)
// // //  Replaces the doSignOut() function defined in the non-module <script>.
// // // ════════════════════════════════════════════════════════════════════════════

// // window.doSignOut = async function () {
// //   const result = await logoutUser();
// //   if (result.ok) {
// //     document.getElementById("nav-profile-btn")?.classList.remove("show");
// //     const signinBtn = document.getElementById("nav-signin-btn");
// //     if (signinBtn) signinBtn.classList.add("show");
// //     document.getElementById("avatar-dropdown")?.classList.remove("open");
// //     window.location.href = "index.html";
// //   } else {
// //     localStorage.removeItem("np_auth");
// //     window.location.reload();
// //   }
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  UNREAD MESSAGES CHECK (unchanged from original)
// // // ════════════════════════════════════════════════════════════════════════════

// // async function checkUnreadMessages(uid) {
// //   try {
// //     const { collection: col, getDocs: gd, query: q, where: w } =
// //       await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
// //     const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
// //     if (!snap.empty) {
// //       const dot = document.getElementById("nav-msg-dot");
// //       if (dot) dot.style.display = "inline-block";
// //     }
// //   } catch (_) {}
// // }


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PASSWORD VISIBILITY TOGGLE
// // // ════════════════════════════════════════════════════════════════════════════

// // window.togglePw = function (inputId, btn) {
// //   const inp = document.getElementById(inputId);
// //   if (!inp) return;
// //   const isText = inp.type === "text";
// //   inp.type  = isText ? "password" : "text";
// //   btn.textContent = isText ? "👁" : "🙈";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  ACCOUNT MODAL HELPERS (unchanged from original)
// // // ════════════════════════════════════════════════════════════════════════════

// // window.proceedToAuth = function () {
// //   document.getElementById("acct-step-save").style.display = "none";
// //   const user = auth.currentUser;
// //   if (user) {
// //     (async () => {
// //       await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
// //       await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
// //       if (typeof window.saveLocalProfile === "function")
// //         window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
// //       const isEdit = !!window._pendingFormData?._editUid;
// //       if (typeof window.showAccountDone === "function")
// //         window.showAccountDone(
// //           "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
// //           isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
// //         );
// //     })();
// //   } else {
// //     const authStep = document.getElementById("acct-step-auth");
// //     if (authStep) authStep.style.display = "block";
// //   }
// // };

// // window.switchAuthTab = function (tab) {
// //   if (tab === "create" && window._regClosed) {
// //     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
// //     return;
// //   }
// //   ["create", "login"].forEach((t) => {
// //     document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
// //   });
// //   const authCreate = document.getElementById("auth-create");
// //   const authLogin  = document.getElementById("auth-login");
// //   if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
// //   if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
// // };

// // window.skipAccount = function () { window.closeAccountModal(); };
// // window.closeAccountModal = function () {
// //   const m = document.getElementById("accountModal");
// //   if (m) m.style.display = "none";
// //   // Save to localStorage as backup since user skipped sign-in
// //   saveLocalStorageDraft();
// // };

// // window.openAccountModal = function (formData) {
// //   window._pendingFormData = formData;
// //   window._isForSelf  = window._planForSelf   !== false;
// //   window._relName    = window._planOtherName  || "";
// //   window._relation   = window._planOtherRelation || "";
// //   document.getElementById("acct-step-save").style.display  = "block";
// //   document.getElementById("acct-step-auth").style.display  = "none";
// //   document.getElementById("acct-step-done").style.display  = "none";
// //   const m = document.getElementById("accountModal");
// //   if (m) m.style.display = "flex";
// // };


// // // ════════════════════════════════════════════════════════════════════════════
// // //  PUBLIC API — exposed on window.NP_FB for external scripts
// // // ════════════════════════════════════════════════════════════════════════════

// // window.NP_FB = {
// //   auth,
// //   db,
// //   createAccount,
// //   loginUser,
// //   logoutUser,
// //   saveAssessmentData,
// //   loadAssessmentData,
// //   autoSaveAssessment,
// //   stopAutoSave,
// //   saveLocalStorageDraft,
// //   collectFormData,
// // };

// // // Also expose the firebase instances directly (backwards compat)
// // window.auth = auth;
// // window.db   = db;



















// /**
//  * ═══════════════════════════════════════════════════════════════
//  *  firebase.js  —  NutriPlan Firebase Integration Module
//  *  All Firebase Auth + Firestore logic lives here.
//  *  Imported by onboarding.html as a ES module script.
//  * ═══════════════════════════════════════════════════════════════
//  *
//  *  EXPORTS (attached to window for non-module scripts to call):
//  *    window.NP_FB = {
//  *      auth, db,
//  *      createAccount(), loginUser(), logoutUser(),
//  *      saveAssessmentData(), loadAssessmentData(),
//  *      autoSaveAssessment(), stopAutoSave()
//  *    }
//  *
//  *  AUTH FLOW:
//  *    1. On page load  → onAuthStateChanged fires
//  *       • Signed in   → show avatar, preload saved data into form
//  *       • Signed out  → show "Sign In" button, try restoring localStorage draft
//  *
//  *    2. On form submit (submitForm) in onboarding.html:
//  *       • If user NOT signed in → openAccountModal() is called
//  *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
//  *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
//  *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
//  *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
//  *       • If user IS signed in  → saveAssessmentData() called immediately
//  *
//  *  SAVING FLOW (saveAssessmentData):
//  *    Reads all form fields + calculated metrics into one flat object.
//  *    Writes to THREE Firestore paths under the authenticated user's UID:
//  *      • users/{uid}/profile          — name, email, phone, basic info
//  *      • users/{uid}/assessment/current — all assessment fields + calculated data
//  *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
//  *    Also mirrors full submission to the legacy "submissions/{userId}" path
//  *    so admin tools continue to work unchanged.
//  *
//  *  LOADING FLOW (loadAssessmentData):
//  *    Reads users/{uid}/assessment/current from Firestore.
//  *    Restores every form field, chip selections, MSDD dropdowns, etc.
//  *    Falls back to localStorage draft if Firestore has no saved data.
//  *
//  *  AUTO-SAVE LOGIC:
//  *    When a user is signed in, we start a 5-second debounce interval.
//  *    Any form interaction resets the timer. After 5 s of inactivity the
//  *    draft is persisted to Firestore (users/{uid}/assessment/current).
//  *    Auto-save is stopped when the modal is open or the form is submitted.
//  *
//  *  LOCALSTORAGE BACKUP:
//  *    When a user skips account creation OR is not signed in, the draft is
//  *    written to localStorage under "nutriplan_ls_draft".
//  *    On page reload, loadAssessmentData() restores it if no Firestore data
//  *    is available.
//  */

// // ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
// import { initializeApp }
//   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// import {
//   getAuth,
//   createUserWithEmailAndPassword,
//   signInWithEmailAndPassword,
//   signOut as fbSignOut,
//   onAuthStateChanged,
//   sendPasswordResetEmail,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// import {
//   getFirestore,
//   doc,
//   getDoc,
//   setDoc,
//   collection,
//   serverTimestamp,
//   onSnapshot,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// // ── Firebase project config ──────────────────────────────────────────────────
// const firebaseConfig = {
//   apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
//   authDomain:        "nutriplan-65582.firebaseapp.com",
//   projectId:         "nutriplan-65582",
//   storageBucket:     "nutriplan-65582.firebasestorage.app",
//   messagingSenderId: "851509980462",
//   appId:             "1:851509980462:web:b18af741addba334ca1ebf",
//   measurementId:     "G-2XZZ9YW5FJ",
// };

// // ── Initialise Firebase ───────────────────────────────────────────────────────
// const app  = initializeApp(firebaseConfig);
// const auth = getAuth(app);
// const db   = getFirestore(app);

// // Expose auth + db to window so legacy inline scripts can reference them
// window._fbAuth = auth;
// window._fbDb   = db;


// // ════════════════════════════════════════════════════════════════════════════
// //  HELPERS
// // ════════════════════════════════════════════════════════════════════════════

// /** Map Firebase auth error codes to user-friendly messages. */
// function friendlyAuthError(code) {
//   const map = {
//     "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
//     "auth/invalid-email":          "Please enter a valid email address.",
//     "auth/weak-password":          "Password is too weak — minimum 6 characters.",
//     "auth/user-not-found":         "No account found with that email.",
//     "auth/wrong-password":         "Incorrect password. Please try again.",
//     "auth/invalid-credential":     "Incorrect email or password.",
//     "auth/network-request-failed": "Network error — please check your connection and try again.",
//     "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
//   };
//   return map[code] || "Authentication error. Please try again.";
// }

// /** Check whether a Firestore "restrictedUsers" doc exists for this email. */
// async function checkUserNotRestricted(email) {
//   const docId = email.toLowerCase().replace(/[@.]/g, "_");
//   try {
//     const snap = await getDoc(doc(db, "restrictedUsers", docId));
//     if (snap.exists()) return false;
//   } catch (_) {}
//   return true;
// }

// /** Check whether the global settings allow new registrations. */
// async function checkRegistrationOpen() {
//   try {
//     const snap = await getDoc(doc(db, "settings", "global"));
//     if (snap.exists() && snap.data().registrationClosed === true) return false;
//   } catch (err) {
//     // permission-denied means the rules block unauthenticated reads on settings/global
//     // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
//     if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
//   }
//   return true;
// }

// /** Safely read a DOM element value. */
// const gv = (id) => document.getElementById(id)?.value ?? "";

// /** Read all active chip texts from a CSS selector. */
// const activeChips = (sel) =>
//   [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// // ════════════════════════════════════════════════════════════════════════════
// //  COLLECT FORM DATA
// //  Reads every field on the assessment form into a plain JS object.
// //  Called by saveAssessmentData() and the legacy submitForm().
// // ════════════════════════════════════════════════════════════════════════════

// function collectFormData() {
//   // Safe field reader — returns "-" if element missing or value empty
//   const fv = (id) => { const el = document.getElementById(id); return (el?.value || "").trim() || "-"; };
//   const fb = (id) => { const el = document.getElementById(id); return el ? (el.checked ? "Yes" : "No") : "-"; };
//   const fc = (sel) => { const r = [...document.querySelectorAll(sel + ".active")].map(c => c.textContent.trim()); return r.length ? r.join(", ") : "-"; };
//   const fm = (key) => { const r = ((window.msddState || {})[key] || []); return r.length ? r.join(", ") : "-"; };

//   const d   = window._lastCalcData || {};
//   const ht  = d.ht  || 0;
//   const wt  = d.wt  || 0;
//   const bmiNum = ht > 0 ? wt / ((ht / 100) ** 2) : 0;
//   const bmiCat = bmiNum < 18.5 ? "Underweight" : bmiNum < 25 ? "Normal" : bmiNum < 30 ? "Overweight" : "Obese";

//   const waistVal = parseFloat(document.getElementById("inp-waist")?.value) || 0;
//   const neckVal  = parseFloat(document.getElementById("inp-neck")?.value)  || 0;
//   const hipVal   = parseFloat(document.getElementById("inp-hip")?.value)   || 0;
//   const gender   = document.getElementById("inp-gender")?.value || d.gender || "";

//   // Weekend eating rule
//   const werEnabled    = document.getElementById("wer-yes-btn")?.classList.contains("active") ? "Yes" : "No";
//   const werDays       = [...document.querySelectorAll(".wer-day-chip.active")].map(c => c.dataset.day || c.textContent.trim());
//   const werRule       = [...document.querySelectorAll(".wer-rule-chip.active")].map(c => c.dataset.rule || c.textContent.trim());
//   const werCustom     = (document.getElementById("wer-custom-input")?.value || "").trim();
//   const werRepeatDays = [...document.querySelectorAll(".wer-repeat-chip.active")].map(c => c.textContent.trim());

//   const planForSelf = window._planForSelf !== false;

//   return {
//     // ── IDs & metadata ──
//     timestamp: new Date().toISOString(),

//     // ── Plan context ──
//     plan_for:            planForSelf ? "Self" : "Other",
//     plan_other_name:     planForSelf ? "-" : (document.getElementById("plan-other-name")?.value || "-").trim(),
//     plan_other_relation: planForSelf ? "-" : (document.getElementById("plan-other-relation")?.value || "-").trim(),

//     // ── Personal details ──
//     name:   (document.getElementById("inp-name")?.value || "").trim() || "-",
//     age:    fv("inp-age"),
//     gender: gender || "-",
//     phone:  fv("inp-phone"),
//     email:  fv("inp-email"),

//     // ── Body measurements ──
//     height:           ht ? String(ht) : "-",
//     height_unit:      (document.querySelector(".hcb-tab.active")?.textContent || "-").trim(),
//     weight:           wt ? String(wt) : "-",
//     waist:            waistVal ? String(waistVal) : "-",
//     neck:             neckVal  ? String(neckVal)  : "-",
//     hip:              (gender === "Female" && hipVal) ? String(hipVal) : (gender === "Female" ? "-" : "N/A"),
//     pregnancy_status: fv("inp-preg"),
//     // Save the human-readable label (e.g. "Sedentary — Little or no exercise…")
//     // rather than the raw factor number so admin sees meaningful text.
//     activity_level: (() => {
//       const sel = document.getElementById("inp-activity");
//       if (!sel || !sel.value) return "-";
//       const opt = sel.options[sel.selectedIndex];
//       return opt ? opt.text.trim() : sel.value;
//     })(),
//     activity_factor: fv("inp-activity"),  // keep the numeric factor for calculations

//     // ── Calculated metrics ──
//     bmi:                  bmiNum > 0 ? bmiNum.toFixed(1) : "-",
//     bmi_category:         bmiNum > 0 ? bmiCat : "-",
//     body_fat:             "-",  // computed from measurements only at submit time
//     ideal_weight:         d.idealWeight ? d.idealWeight.toFixed(1) : "-",
//     current_weight:       wt ? String(wt) : "-",
//     weight_to_goal:       d.kgDiff ? d.kgDiff.toFixed(1) + " kg" : "-",
//     goal_direction:       d.direction || "-",
//     bmr:                  d.bmr ? String(Math.round(d.bmr)) : "-",
//     maintenance_calories: d.maintenance ? String(d.maintenance) : "-",
//     goal_calories: (() => {
//       if (!d.maintenance) return "-";
//       const rate = window._currentGoalRate || 0.5;
//       let gc = d.direction === "loss" ? d.maintenance - Math.round(rate * 1000)
//              : d.direction === "gain" ? d.maintenance + Math.round(rate * 600)
//              : d.maintenance;
//       return String(Math.max(1000, gc));
//     })(),
//     goal_rate_kg_per_week: String(window._currentGoalRate || 0.5),
//     timeline_days: (() => {
//       if (!d.kgDiff || d.direction === "maintain") return "-";
//       return String(Math.round((d.kgDiff / (window._currentGoalRate || 0.5)) * 7));
//     })(),
//     after_goal_calories: (() => {
//       if (!d.idealWeight || !ht || !d.age) return "-";
//       const afterBmr = gender === "Female"
//         ? (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) - 161
//         : (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) + 5;
//       return String(Math.round(afterBmr * (parseFloat(d.activity) || 1.2)));
//     })(),

//     // ── Health ──
//     health_conditions: [...(window.selectedConditions ?? new Set())].join(", ") || "-",
//     allergies:         fv("inp-allergies"),

//     // ── Diet preferences ──
//     diet_preference: fv("inp-diet"),
//     num_curries:     fv("inp-curries"),
//     meal_types:      fc("#meal-types .chip"),
//     eating_window:   fv("eat-window-val"),

//     // ── Weekend eating rule ──
//     weekend_eating_rule:        werEnabled,
//     weekend_eating_days:        werDays.length    ? werDays.join(", ")    : "-",
//     weekend_eating_rule_type:   werRule.length    ? werRule.join(", ")    : "-",
//     weekend_eating_custom_rule: werCustom         || "-",
//     weekend_eating_repeat_days: werRepeatDays.length ? werRepeatDays.join(", ") : "-",

//     // ── Food preferences — MSDD dropdowns ──
//     morning_drinks:  fm("msdd-drinks"),
//     nuts:            fm("msdd-nuts"),
//     seeds:           fm("msdd-seeds"),
//     fruits:          fm("msdd-fruits"),
//     vegetables:      fm("msdd-veggies"),
//     sprouts:         fm("msdd-sprouts"),
//     milkshakes:      fm("msdd-milkshakes"),
//     smoothies:       fm("msdd-smoothies"),
//     porridge_malt:   fm("msdd-porridge"),
//     breakfast:       fm("msdd-breakfast"),
//     chutney:         fm("msdd-chutney"),
//     powders_ghee:    fm("msdd-powders"),
//     non_veg:         fm("msdd-nonveg"),
//     rice:            fm("msdd-rice"),
//     millets_grains:  fm("msdd-millets"),

//     // ── Symptoms & final notes ──
//     symptoms:         fc("#symptoms-group .chip"),
//     food_dislikes:    fv("inp-dislikes"),
//     comments:         fv("inp-comments"),
//     whatsapp_consent: fb("consent-wa"),
//   };
// }



// // ════════════════════════════════════════════════════════════════════════════
// //  saveAssessmentData(uid)
// //  Writes all assessment fields + metadata to Firestore under the user's UID.
// //
// //  Firestore structure:
// //    users/{uid}/profile          — name, email, phone
// //    users/{uid}/assessment/current — full assessment snapshot
// //    users/{uid}/progress         — goals, BMI, body fat, timestamps
// //
// //  Also writes to legacy submissions/{submissionId} for admin compatibility.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveAssessmentData(uid, submissionId) {
//   if (!uid) {
//     console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
//     return;
//   }

//   const data = collectFormData();
//   const now  = serverTimestamp();

//   try {
//     // 1. Profile document (quick lookup fields)
//     await setDoc(
//       doc(db, "users", uid, "profile", "info"),
//       {
//         name:      data.name,
//         email:     data.email || auth.currentUser?.email || "",
//         phone:     data.phone,
//         updatedAt: now,
//       },
//       { merge: true }
//     );

//     // 2. Full assessment snapshot (overwrites on each save)
//     await setDoc(
//       doc(db, "users", uid, "assessment", "current"),
//       {
//         ...data,
//         uid,
//         submissionId: submissionId || "",
//         savedAt: now,
//       }
//     );

//     // 3. Progress / goal metrics document
//     await setDoc(
//       doc(db, "users", uid, "progress", "latest"),
//       {
//         bmi:              data.bmi,
//         bmi_category:     data.bmi_category,
//         body_fat:         data.body_fat,
//         ideal_weight:     data.ideal_weight,
//         goal_direction:   data.goal_direction,
//         goal_calories:    data.goal_calories,
//         maintenance_calories: data.maintenance_calories,
//         bmr:              data.bmr,
//         recordedAt:       now,
//       },
//       { merge: true }
//     );

//     console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
//   } catch (err) {
//     console.error("[NP Firebase] saveAssessmentData error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loadAssessmentData(uid)
// //  Reads users/{uid}/assessment/current and restores the form.
// //  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// // ════════════════════════════════════════════════════════════════════════════

// async function loadAssessmentData(uid) {
//   let data = null;

//   if (uid) {
//     try {
//       const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
//       if (snap.exists()) {
//         data = snap.data();
//         console.info("[NP Firebase] Assessment loaded from Firestore.");
//       }
//     } catch (err) {
//       console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
//     }
//   }

//   // Fall back to localStorage draft
//   if (!data) {
//     try {
//       const raw = localStorage.getItem("nutriplan_ls_draft");
//       if (raw) data = JSON.parse(raw);
//       if (data) console.info("[NP Firebase] Assessment loaded from localStorage draft.");
//     } catch (_) {}
//   }

//   if (!data) return; // Nothing to restore

//   // ── Restore simple text/number/select fields ──
//   const set = (id, val) => {
//     const el = document.getElementById(id);
//     if (el && val !== undefined && val !== null && val !== "") el.value = val;
//   };

//   set("inp-name",     data.name);
//   set("inp-age",      data.age);
//   set("inp-phone",    data.phone);
//   set("inp-email",    data.email);
//   set("inp-allergies",data.allergies);
//   set("inp-dislikes", data.food_dislikes);
//   set("inp-comments", data.comments);
//   set("inp-curries",  data.num_curries);
//   set("eat-window-val", data.eating_window);

//   if (data.height) {
//     set("inp-height",    data.height);
//     set("inp-height-cm", Math.round(data.height));
//   }
//   set("inp-weight",   data.weight);
//   set("inp-preg",     data.pregnancy_status);

//   // Measurements
//   ["waist", "neck", "hip"].forEach((m) => {
//     const val = data[m];
//     if (!val) return;
//     const raw = document.getElementById(m + "-raw-input");
//     const hid = document.getElementById("inp-" + m);
//     if (raw) raw.value = val;
//     if (hid) hid.value = val;
//   });

//   // Gender (triggers female row visibility)
//   if (data.gender) {
//     set("inp-gender", data.gender);
//     const femRow = document.getElementById("female-extra-row");
//     if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
//   }

//   // activity_factor stores the numeric select value; activity_level stores the label (new). Support both.
//   if (data.activity_factor && data.activity_factor !== "-") set("inp-activity", data.activity_factor);
//   else if (data.activity_level && /^\d/.test(data.activity_level)) set("inp-activity", data.activity_level); // legacy fallback
//   if (data.diet_preference) set("inp-diet",     data.diet_preference);
//   if (document.getElementById("consent-wa"))
//     document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

//   // ── Restore chip selections ──
//   const restoreChips = (selector, csvString) => {
//     if (!csvString) return;
//     const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
//     document.querySelectorAll(selector).forEach((chip) => {
//       if (active.includes(chip.textContent.trim())) chip.classList.add("active");
//     });
//   };
//   restoreChips("#meal-types .chip",      data.meal_types);
//   restoreChips("#symptoms-group .chip",  data.symptoms);

//   // Eating time chip
//   if (data.eating_window) {
//     document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
//       if (tc.dataset.value === data.eating_window) tc.classList.add("active");
//     });
//   }

//   // ── Restore Weekend Eating Rule ──
//   if (data.weekend_eating_rule === "Yes") {
//     const yesBtn = document.getElementById("wer-yes-btn");
//     const noBtn  = document.getElementById("wer-no-btn");
//     if (yesBtn) { yesBtn.classList.add("active"); }
//     if (noBtn)  { noBtn.classList.remove("active"); }
//     // Show the WER panel if it exists
//     const werPanel = document.getElementById("wer-panel") || document.querySelector(".wer-options");
//     if (werPanel) werPanel.style.display = "block";
//   }
//   // Restore selected WER days
//   if (data.weekend_eating_days && data.weekend_eating_days !== "-") {
//     const days = data.weekend_eating_days.split(",").map(v => v.trim()).filter(Boolean);
//     document.querySelectorAll(".wer-day-chip").forEach(chip => {
//       const d2 = chip.dataset.day || chip.textContent.trim();
//       if (days.includes(d2)) chip.classList.add("active");
//     });
//   }
//   // Restore WER rule chips
//   if (data.weekend_eating_rule_type && data.weekend_eating_rule_type !== "-") {
//     const rules = data.weekend_eating_rule_type.split(",").map(v => v.trim()).filter(Boolean);
//     document.querySelectorAll(".wer-rule-chip").forEach(chip => {
//       if (rules.includes(chip.dataset.rule || chip.textContent.trim())) chip.classList.add("active");
//     });
//   }
//   // Restore WER custom text
//   if (data.weekend_eating_custom_rule && data.weekend_eating_custom_rule !== "-") {
//     const werCustom = document.getElementById("wer-custom-input");
//     if (werCustom) werCustom.value = data.weekend_eating_custom_rule;
//   }
//   // Restore WER repeat-days chips
//   if (data.weekend_eating_repeat_days && data.weekend_eating_repeat_days !== "-") {
//     const repeatDays = data.weekend_eating_repeat_days.split(",").map(v => v.trim()).filter(Boolean);
//     document.querySelectorAll(".wer-repeat-chip").forEach(chip => {
//       if (repeatDays.includes(chip.textContent.trim())) chip.classList.add("active");
//     });
//     // Show repeat row if chips are active
//     const repeatRow = document.getElementById("wer-repeat-row");
//     if (repeatRow) repeatRow.style.display = "flex";
//   }

//   // ── Restore MSDD dropdowns ──
//   const msddMap = {
//     "msdd-drinks":    data.morning_drinks,
//     "msdd-fruits":    data.fruits,
//     "msdd-veggies":   data.vegetables,
//     "msdd-sprouts":   data.sprouts,
//     "msdd-milkshakes":data.milkshakes,
//     "msdd-smoothies": data.smoothies,
//     "msdd-porridge":  data.porridge_malt,
//     "msdd-breakfast": data.breakfast,
//     "msdd-chutney":   data.chutney,
//     "msdd-powders":   data.powders_ghee,
//     "msdd-nonveg":    data.non_veg,
//     "msdd-rice":      data.rice,
//     "msdd-millets":   data.millets_grains,
//   };
//   Object.entries(msddMap).forEach(([id, csv]) => {
//     if (!csv) return;
//     csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.msddChange === "function") window.msddChange(id);
//   });

//   // Nuts + seeds (stored combined in "nuts_seeds")
//   if (data.nuts_seeds) {
//     data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       ["msdd-nuts", "msdd-seeds"].forEach((id) => {
//         const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//         if (cb) cb.checked = true;
//       });
//     });
//     if (typeof window.msddChange === "function") {
//       window.msddChange("msdd-nuts");
//       window.msddChange("msdd-seeds");
//     }
//   }

//   // ── Restore health conditions ──
//   if (data.health_conditions) {
//     const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
//     conds.forEach((v) => {
//       if (window.selectedConditions) window.selectedConditions.add(v);
//       const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.renderTags === "function") window.renderTags();
//   }

//   // Open hidden sections that were visible
//   ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
//     setTimeout(() => {
//       const el = document.getElementById(id);
//       if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
//     }, i * 100);
//   });

//   console.info("[NP Firebase] Form restored from saved data.");
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveLocalStorageDraft()
// //  Writes a lightweight draft to localStorage for users who skip sign-in.
// //  Called by autoSaveAssessment() when not signed in.
// // ════════════════════════════════════════════════════════════════════════════

// function saveLocalStorageDraft() {
//   try {
//     const data = collectFormData();
//     localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
//   } catch (err) {
//     console.warn("[NP Firebase] localStorage backup error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  AUTO-SAVE LOGIC
// //  When signed in: debounce-saves to Firestore after 5 s of inactivity.
// //  When not signed in: saves to localStorage after 3 s of inactivity.
// //  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// // ════════════════════════════════════════════════════════════════════════════

// let _autoSaveTimer   = null;
// let _autoSaveEnabled = false;

// /** Trigger a debounced auto-save. Call this from form input listeners. */
// function scheduleAutoSave() {
//   if (!_autoSaveEnabled) return;
//   clearTimeout(_autoSaveTimer);

//   const user = auth.currentUser;
//   const delay = user ? 5000 : 3000;

//   _autoSaveTimer = setTimeout(async () => {
//     if (auth.currentUser) {
//       // Auto-save to Firestore
//       await saveAssessmentData(auth.currentUser.uid);
//     } else {
//       // Auto-save to localStorage
//       saveLocalStorageDraft();
//     }
//   }, delay);
// }

// /** Start auto-save listeners on all form inputs. */
// function autoSaveAssessment() {
//   _autoSaveEnabled = true;

//   const attach = () => {
//     document.querySelectorAll("input, select, textarea").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("input",  scheduleAutoSave);
//         el.addEventListener("change", scheduleAutoSave);
//       }
//     });
//     // Chips and toggle buttons
//     document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
//       }
//     });
//   };

//   attach();
//   // Re-attach after any dynamically rendered chips
//   new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

//   console.info("[NP Firebase] Auto-save enabled.");
// }

// /** Pause auto-save (e.g. while a modal is open or after final submission). */
// function stopAutoSave() {
//   _autoSaveEnabled = false;
//   clearTimeout(_autoSaveTimer);
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  createAccount(email, password)
// //  Creates a new Firebase Auth user and saves assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function createAccount(email, password) {
//   // Validate inputs
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (password.length < 6)
//     return { ok: false, error: "Password must be at least 6 characters." };

//   // Check server-side gates
//   const regOpen = await checkRegistrationOpen();
//   if (!regOpen)
//     return { ok: false, error: "New registrations are currently closed." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This email address is not allowed to register." };

//   try {
//     // Create Firebase Auth account
//     const cred = await createUserWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Persist account metadata
//     await setDoc(
//       doc(db, "accounts", uid),
//       { email, createdAt: serverTimestamp() }
//     );

//     // Save all pending assessment data to Firestore
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     // Store session hints
//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     // Remove localStorage draft — it's now in Firestore
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Account created:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] createAccount error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loginUser(email, password)
// //  Signs the user in and saves any pending assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function loginUser(email, password) {
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (!password)
//     return { ok: false, error: "Enter your password." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This account has been restricted." };

//   try {
//     const cred = await signInWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Save pending assessment data
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Signed in:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] loginUser error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  logoutUser()
// //  Signs out of Firebase Auth and clears session hints.
// // ════════════════════════════════════════════════════════════════════════════

// async function logoutUser() {
//   try {
//     stopAutoSave();
//     await fbSignOut(auth);

//     localStorage.removeItem("nutriplan_uid");
//     localStorage.removeItem("nutriplan_email");
//     localStorage.removeItem("np_auth");

//     console.info("[NP Firebase] Signed out.");
//     return { ok: true };
//   } catch (err) {
//     console.error("[NP Firebase] logoutUser error:", err.message);
//     return { ok: false, error: err.message };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
// //  Mirrors a submission to the "submissions" collection used by admin tools.
// //  Preserved 100% from the original firebase module so nothing breaks.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
//   try {
//     const isEdit = !!(formData._editUid);
//     let resolvedUid = accountUid || null;
//     if (isEdit) {
//       try {
//         const snap = await getDoc(doc(db, "submissions", formData.userId));
//         if (snap.exists() && snap.data().accountUid)
//           resolvedUid = snap.data().accountUid;
//       } catch (_) {}
//     }
//     const entry = {
//       ...formData,
//       accountUid: resolvedUid,
//       forSelf:    forSelf !== false,
//       relName:    relName  || "",
//       relation:   relation || "",
//       ...(isEdit
//         ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
//         : { createdAt: serverTimestamp() }),
//     };
//     delete entry._editUid;
//     await setDoc(
//       doc(db, "submissions", formData.userId),
//       entry,
//       isEdit ? { merge: false } : {}
//     );
//     if (resolvedUid) {
//       await setDoc(
//         doc(db, "accounts", resolvedUid, "profiles", formData.userId),
//         {
//           userId:    formData.userId,
//           name:      formData.name,
//           forSelf:   entry.forSelf,
//           relName:   entry.relName,
//           relation:  entry.relation,
//           timestamp: formData.timestamp,
//         }
//       );
//     }
//   } catch (err) {
//     console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
//   }
// }

// // Expose legacy function under original name so existing inline code still works
// window.saveToFirestore = saveToFirestoreLegacy;


// // ════════════════════════════════════════════════════════════════════════════
// //  onAuthStateChanged — central auth observer
// //  • Signed in  → show avatar with initials, preload saved form data
// //  • Signed out → show "Sign In" button, try loading localStorage draft
// // ════════════════════════════════════════════════════════════════════════════

// onAuthStateChanged(auth, async (user) => {
//   const profileBtn = document.getElementById("nav-profile-btn");
//   const signinBtn  = document.getElementById("nav-signin-btn");
//   const step0Block = document.getElementById("step0-block");

//   if (user) {
//     // Restriction check
//     const allowed = await checkUserNotRestricted(user.email || "");
//     if (!allowed) {
//       await fbSignOut(auth);
//       localStorage.removeItem("np_auth");
//       if (profileBtn) profileBtn.classList.remove("show");
//       if (signinBtn)  signinBtn.classList.add("show");
//       return;
//     }

//     // Show avatar with email initial
//     if (profileBtn) {
//       const initial = (user.email || "U")[0].toUpperCase();
//       profileBtn.textContent = initial;
//       profileBtn.classList.add("show");
//     }
//     if (signinBtn) signinBtn.classList.remove("show");

//     // Show auth-gated nav links (Dietplan, Comments, Messages) on any page
//     localStorage.setItem("np_auth", "signed-in");
//     if (typeof window._updateAuthNavLinks === "function") window._updateAuthNavLinks(true);

//     // Start auto-save now that the user is authenticated
//     autoSaveAssessment();

//     // Pre-load any previously saved assessment data into the form
//     // (only if no session draft is present, to avoid overwriting a fresh session)
//     const hasSessionDraft = !!sessionStorage.getItem("nutriplan_draft");
//     if (!hasSessionDraft) {
//       await loadAssessmentData(user.uid);
//     }

//   } else {
//     // Not signed in
//     localStorage.removeItem("np_auth");
//     if (profileBtn) profileBtn.classList.remove("show");
//     if (signinBtn)  signinBtn.classList.add("show");
//     if (step0Block) step0Block.style.display = "none";
//     // Hide auth-gated nav links
//     if (typeof window._updateAuthNavLinks === "function") window._updateAuthNavLinks(false);

//     // Still start auto-save so localStorage draft stays fresh
//     autoSaveAssessment();
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
// //  Re-uses the exact same logic from the original firebase module.
// // ════════════════════════════════════════════════════════════════════════════

// window._regClosed = true;

// onSnapshot(doc(db, "settings", "global"), (snap) => {
//   if (snap.exists()) {
//     const data        = snap.data();
//     const formClosed  = !!data.formSubmissionClosed;
//     const regClosed   = !!data.registrationClosed;

//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(formClosed);

//     window._regClosed = regClosed;

//     // Keep modal tabs in sync if modal is open
//     const modal = document.getElementById("accountModal");
//     if (modal && modal.style.display === "flex") {
//       if (regClosed) {
//         if (typeof window.applyModalRegClosedState === "function")
//           window.applyModalRegClosedState();
//       } else {
//         ["create", "login"].forEach((t) => {
//           const tab = document.getElementById("tab-" + t);
//           if (tab) {
//             tab.classList.remove("active");
//             tab.style.opacity = "";
//             tab.style.cursor  = "";
//             tab.style.pointerEvents = "";
//             tab.title = "";
//           }
//         });
//         document.getElementById("tab-create")?.classList.add("active");
//         const authCreate = document.getElementById("auth-create");
//         const authLogin  = document.getElementById("auth-login");
//         if (authCreate) authCreate.style.display = "block";
//         if (authLogin)  authLogin.style.display  = "none";
//         const notice = document.getElementById("modal-reg-closed-notice");
//         if (notice) notice.style.display = "none";
//       }
//     }
//   } else {
//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(false);
//     window._regClosed = false;
//   }
// }, (err) => {
//   // "Missing or insufficient permissions" is expected when the user is signed out
//   // and Firestore rules require auth for this document.
//   // Fix: set `allow read: if true` on settings/global in your Firestore rules.
//   // We only log unexpected errors (not permission denials).
//   if (err.code !== 'permission-denied') {
//     console.warn("[NP Firebase] settings read error:", err.code, err.message);
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD RESET
// //  Exposed globally so the existing forgotModal can call it.
// // ════════════════════════════════════════════════════════════════════════════

// window.doResetPassword = async function () {
//   const email = document.getElementById("fp-email")?.value?.trim();
//   const errEl = document.getElementById("fp-err");
//   const sucEl = document.getElementById("fp-suc");
//   if (errEl) errEl.style.display = "none";
//   if (sucEl) sucEl.style.display = "none";

//   if (!email || !/\S+@\S+\.\S+/.test(email)) {
//     if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
//     return;
//   }
//   try {
//     await sendPasswordResetEmail(auth, email);
//     if (sucEl) {
//       sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
//       sucEl.style.display = "block";
//     }
//     setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
//   } catch (err) {
//     if (errEl) {
//       errEl.textContent = err.code === "auth/user-not-found"
//         ? "No account found with this email."
//         : friendlyAuthError(err.code);
//       errEl.style.display = "block";
//     }
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
// //  These override the window.createAccount and window.signInExisting
// //  originally defined inline in onboarding.html.
// // ════════════════════════════════════════════════════════════════════════════

// window.createAccount = async function () {
//   const errEl = document.getElementById("acct-err");
//   if (errEl) errEl.style.display = "none";

//   if (window._regClosed) {
//     if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }

//   const email = document.getElementById("acct-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("acct-pass")?.value  ?? "";
//   const pass2 = document.getElementById("acct-pass2")?.value ?? "";

//   if (pass !== pass2) {
//     if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
//     return;
//   }

//   // Disable button while working
//   const btn = document.querySelector("#auth-create .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

//   const result = await createAccount(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// window.signInExisting = async function () {
//   const errEl = document.getElementById("login-err");
//   if (errEl) errEl.style.display = "none";

//   const email = document.getElementById("login-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("login-pass")?.value ?? "";

//   const btn = document.querySelector("#auth-login .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

//   const result = await loginUser(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  SIGN OUT (called by avatar dropdown)
// //  Replaces the doSignOut() function defined in the non-module <script>.
// // ════════════════════════════════════════════════════════════════════════════

// window.doSignOut = async function () {
//   const result = await logoutUser();
//   if (result.ok) {
//     document.getElementById("nav-profile-btn")?.classList.remove("show");
//     const signinBtn = document.getElementById("nav-signin-btn");
//     if (signinBtn) signinBtn.classList.add("show");
//     document.getElementById("avatar-dropdown")?.classList.remove("open");
//     window.location.href = "Dietplan.html";
//   } else {
//     localStorage.removeItem("np_auth");
//     window.location.reload();
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  UNREAD MESSAGES CHECK (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// async function checkUnreadMessages(uid) {
//   try {
//     const { collection: col, getDocs: gd, query: q, where: w } =
//       await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
//     const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
//     if (!snap.empty) {
//       const dot = document.getElementById("nav-msg-dot");
//       if (dot) dot.style.display = "inline-block";
//     }
//   } catch (_) {}
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD VISIBILITY TOGGLE
// // ════════════════════════════════════════════════════════════════════════════

// window.togglePw = function (inputId, btn) {
//   const inp = document.getElementById(inputId);
//   if (!inp) return;
//   const isText = inp.type === "text";
//   inp.type  = isText ? "password" : "text";
//   btn.textContent = isText ? "👁" : "🙈";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  ACCOUNT MODAL HELPERS (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// window.proceedToAuth = function () {
//   document.getElementById("acct-step-save").style.display = "none";
//   const user = auth.currentUser;
//   if (user) {
//     (async () => {
//       await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
//       await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
//       if (typeof window.saveLocalProfile === "function")
//         window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
//       const isEdit = !!window._pendingFormData?._editUid;
//       if (typeof window.showAccountDone === "function")
//         window.showAccountDone(
//           "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
//           isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
//         );
//     })();
//   } else {
//     const authStep = document.getElementById("acct-step-auth");
//     if (authStep) authStep.style.display = "block";
//   }
// };

// window.switchAuthTab = function (tab) {
//   if (tab === "create" && window._regClosed) {
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }
//   ["create", "login"].forEach((t) => {
//     document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
//   });
//   const authCreate = document.getElementById("auth-create");
//   const authLogin  = document.getElementById("auth-login");
//   if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
//   if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
// };

// window.skipAccount = function () { window.closeAccountModal(); };
// window.closeAccountModal = function () {
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "none";
//   // Save to localStorage as backup since user skipped sign-in
//   saveLocalStorageDraft();
// };

// window.openAccountModal = function (formData) {
//   window._pendingFormData = formData;
//   window._isForSelf  = window._planForSelf   !== false;
//   window._relName    = window._planOtherName  || "";
//   window._relation   = window._planOtherRelation || "";
//   document.getElementById("acct-step-save").style.display  = "block";
//   document.getElementById("acct-step-auth").style.display  = "none";
//   document.getElementById("acct-step-done").style.display  = "none";
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "flex";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  PUBLIC API — exposed on window.NP_FB for external scripts
// // ════════════════════════════════════════════════════════════════════════════

// window.NP_FB = {
//   auth,
//   db,
//   createAccount,
//   loginUser,
//   logoutUser,
//   saveAssessmentData,
//   loadAssessmentData,
//   autoSaveAssessment,
//   stopAutoSave,
//   saveLocalStorageDraft,
//   collectFormData,
// };

// // Also expose the firebase instances directly (backwards compat)
// window.auth = auth;
// window.db   = db;




// /**
//  * ═══════════════════════════════════════════════════════════════
//  *  firebase.js  —  NutriPlan Firebase Integration Module
//  *  All Firebase Auth + Firestore logic lives here.
//  *  Imported by onboarding.html as a ES module script.
//  * ═══════════════════════════════════════════════════════════════
//  *
//  *  EXPORTS (attached to window for non-module scripts to call):
//  *    window.NP_FB = {
//  *      auth, db,
//  *      createAccount(), loginUser(), logoutUser(),
//  *      saveAssessmentData(), loadAssessmentData(),
//  *      autoSaveAssessment(), stopAutoSave()
//  *    }
//  *
//  *  AUTH FLOW:
//  *    1. On page load  → onAuthStateChanged fires
//  *       • Signed in   → show avatar, preload saved data into form
//  *       • Signed out  → show "Sign In" button, try restoring localStorage draft
//  *
//  *    2. On form submit (submitForm) in onboarding.html:
//  *       • If user NOT signed in → openAccountModal() is called
//  *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
//  *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
//  *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
//  *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
//  *       • If user IS signed in  → saveAssessmentData() called immediately
//  *
//  *  SAVING FLOW (saveAssessmentData):
//  *    Reads all form fields + calculated metrics into one flat object.
//  *    Writes to THREE Firestore paths under the authenticated user's UID:
//  *      • users/{uid}/profile          — name, email, phone, basic info
//  *      • users/{uid}/assessment/current — all assessment fields + calculated data
//  *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
//  *    Also mirrors full submission to the legacy "submissions/{userId}" path
//  *    so admin tools continue to work unchanged.
//  *
//  *  LOADING FLOW (loadAssessmentData):
//  *    Reads users/{uid}/assessment/current from Firestore.
//  *    Restores every form field, chip selections, MSDD dropdowns, etc.
//  *    Falls back to localStorage draft if Firestore has no saved data.
//  *
//  *  AUTO-SAVE LOGIC:
//  *    When a user is signed in, we start a 5-second debounce interval.
//  *    Any form interaction resets the timer. After 5 s of inactivity the
//  *    draft is persisted to Firestore (users/{uid}/assessment/current).
//  *    Auto-save is stopped when the modal is open or the form is submitted.
//  *
//  *  LOCALSTORAGE BACKUP:
//  *    When a user skips account creation OR is not signed in, the draft is
//  *    written to localStorage under "nutriplan_ls_draft".
//  *    On page reload, loadAssessmentData() restores it if no Firestore data
//  *    is available.
//  */

// // ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
// import { initializeApp }
//   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// import {
//   getAuth,
//   createUserWithEmailAndPassword,
//   signInWithEmailAndPassword,
//   signOut as fbSignOut,
//   onAuthStateChanged,
//   sendPasswordResetEmail,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// import {
//   getFirestore,
//   doc,
//   getDoc,
//   setDoc,
//   collection,
//   serverTimestamp,
//   onSnapshot,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// // ── Firebase project config ──────────────────────────────────────────────────
// const firebaseConfig = {
//   apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
//   authDomain:        "nutriplan-65582.firebaseapp.com",
//   projectId:         "nutriplan-65582",
//   storageBucket:     "nutriplan-65582.firebasestorage.app",
//   messagingSenderId: "851509980462",
//   appId:             "1:851509980462:web:b18af741addba334ca1ebf",
//   measurementId:     "G-2XZZ9YW5FJ",
// };

// // ── Initialise Firebase ───────────────────────────────────────────────────────
// const app  = initializeApp(firebaseConfig);
// const auth = getAuth(app);
// const db   = getFirestore(app);

// // Expose auth + db to window so legacy inline scripts can reference them
// window._fbAuth = auth;
// window._fbDb   = db;


// // ════════════════════════════════════════════════════════════════════════════
// //  HELPERS
// // ════════════════════════════════════════════════════════════════════════════

// /** Map Firebase auth error codes to user-friendly messages. */
// function friendlyAuthError(code) {
//   const map = {
//     "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
//     "auth/invalid-email":          "Please enter a valid email address.",
//     "auth/weak-password":          "Password is too weak — minimum 6 characters.",
//     "auth/user-not-found":         "No account found with that email.",
//     "auth/wrong-password":         "Incorrect password. Please try again.",
//     "auth/invalid-credential":     "Incorrect email or password.",
//     "auth/network-request-failed": "Network error — please check your connection and try again.",
//     "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
//   };
//   return map[code] || "Authentication error. Please try again.";
// }

// /** Check whether a Firestore "restrictedUsers" doc exists for this email. */
// async function checkUserNotRestricted(email) {
//   const docId = email.toLowerCase().replace(/[@.]/g, "_");
//   try {
//     const snap = await getDoc(doc(db, "restrictedUsers", docId));
//     if (snap.exists()) return false;
//   } catch (_) {}
//   return true;
// }

// /** Check whether the global settings allow new registrations. */
// async function checkRegistrationOpen() {
//   try {
//     const snap = await getDoc(doc(db, "settings", "global"));
//     if (snap.exists() && snap.data().registrationClosed === true) return false;
//   } catch (err) {
//     // permission-denied means the rules block unauthenticated reads on settings/global
//     // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
//     if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
//   }
//   return true;
// }

// /** Safely read a DOM element value. */
// const gv = (id) => document.getElementById(id)?.value ?? "";

// /** Read all active chip texts from a CSS selector. */
// const activeChips = (sel) =>
//   [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// // ════════════════════════════════════════════════════════════════════════════
// //  COLLECT FORM DATA
// //  Reads every field on the assessment form into a plain JS object.
// //  Called by saveAssessmentData() and the legacy submitForm().
// // ════════════════════════════════════════════════════════════════════════════

// function collectFormData() {
//   // Safe field reader — returns "-" if element missing or value empty
//   const fv = (id) => { const el = document.getElementById(id); return (el?.value || "").trim() || "-"; };
//   const fb = (id) => { const el = document.getElementById(id); return el ? (el.checked ? "Yes" : "No") : "-"; };
//   const fc = (sel) => { const r = [...document.querySelectorAll(sel + ".active")].map(c => c.textContent.trim()); return r.length ? r.join(", ") : "-"; };
//   const fm = (key) => { const r = ((window.msddState || {})[key] || []); return r.length ? r.join(", ") : "-"; };

//   const d   = window._lastCalcData || {};
//   const ht  = d.ht  || 0;
//   const wt  = d.wt  || 0;
//   const bmiNum = ht > 0 ? wt / ((ht / 100) ** 2) : 0;
//   const bmiCat = bmiNum < 18.5 ? "Underweight" : bmiNum < 25 ? "Normal" : bmiNum < 30 ? "Overweight" : "Obese";

//   const waistVal = parseFloat(document.getElementById("inp-waist")?.value) || 0;
//   const neckVal  = parseFloat(document.getElementById("inp-neck")?.value)  || 0;
//   const hipVal   = parseFloat(document.getElementById("inp-hip")?.value)   || 0;
//   const gender   = document.getElementById("inp-gender")?.value || d.gender || "";

//   // Weekend eating rule
//   const werEnabled    = document.getElementById("wer-yes-btn")?.classList.contains("active") ? "Yes" : "No";
//   const werDays       = [...document.querySelectorAll(".wer-day-chip.active")].map(c => c.dataset.day || c.textContent.trim());
//   const werRule       = [...document.querySelectorAll(".wer-rule-chip.active")].map(c => c.dataset.rule || c.textContent.trim());
//   const werCustom     = (document.getElementById("wer-custom-input")?.value || "").trim();
//   const werRepeatDays = [...document.querySelectorAll(".wer-repeat-chip.active")].map(c => c.textContent.trim());

//   const planForSelf = window._planForSelf !== false;

//   return {
//     // ── IDs & metadata ──
//     timestamp: new Date().toISOString(),

//     // ── Plan context ──
//     plan_for:            planForSelf ? "Self" : "Other",
//     plan_other_name:     planForSelf ? "-" : (document.getElementById("plan-other-name")?.value || "-").trim(),
//     plan_other_relation: planForSelf ? "-" : (document.getElementById("plan-other-relation")?.value || "-").trim(),

//     // ── Personal details ──
//     name:   (document.getElementById("inp-name")?.value || "").trim() || "-",
//     age:    fv("inp-age"),
//     gender: gender || "-",
//     phone:  fv("inp-phone"),
//     email:  fv("inp-email"),

//     // ── Body measurements ──
//     height:           ht ? String(ht) : "-",
//     height_unit:      (document.querySelector(".hcb-tab.active")?.textContent || "-").trim(),
//     weight:           wt ? String(wt) : "-",
//     waist:            waistVal ? String(waistVal) : "-",
//     neck:             neckVal  ? String(neckVal)  : "-",
//     hip:              (gender === "Female" && hipVal) ? String(hipVal) : (gender === "Female" ? "-" : "N/A"),
//     pregnancy_status: fv("inp-preg"),
//     activity_level:   fv("inp-activity"),

//     // ── Calculated metrics ──
//     bmi:                  bmiNum > 0 ? bmiNum.toFixed(1) : "-",
//     bmi_category:         bmiNum > 0 ? bmiCat : "-",
//     body_fat:             "-",  // computed from measurements only at submit time
//     ideal_weight:         d.idealWeight ? d.idealWeight.toFixed(1) : "-",
//     current_weight:       wt ? String(wt) : "-",
//     weight_to_goal:       d.kgDiff ? d.kgDiff.toFixed(1) + " kg" : "-",
//     goal_direction:       d.direction || "-",
//     bmr:                  d.bmr ? String(Math.round(d.bmr)) : "-",
//     maintenance_calories: d.maintenance ? String(d.maintenance) : "-",
//     goal_calories: (() => {
//       if (!d.maintenance) return "-";
//       const rate = window._currentGoalRate || 0.5;
//       let gc = d.direction === "loss" ? d.maintenance - Math.round(rate * 1000)
//              : d.direction === "gain" ? d.maintenance + Math.round(rate * 600)
//              : d.maintenance;
//       return String(Math.max(1000, gc));
//     })(),
//     goal_rate_kg_per_week: String(window._currentGoalRate || 0.5),
//     timeline_days: (() => {
//       if (!d.kgDiff || d.direction === "maintain") return "-";
//       return String(Math.round((d.kgDiff / (window._currentGoalRate || 0.5)) * 7));
//     })(),
//     after_goal_calories: (() => {
//       if (!d.idealWeight || !ht || !d.age) return "-";
//       const afterBmr = gender === "Female"
//         ? (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) - 161
//         : (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) + 5;
//       return String(Math.round(afterBmr * (parseFloat(d.activity) || 1.2)));
//     })(),

//     // ── Health ──
//     health_conditions: [...(window.selectedConditions ?? new Set())].join(", ") || "-",
//     allergies:         fv("inp-allergies"),

//     // ── Diet preferences ──
//     diet_preference: fv("inp-diet"),
//     num_curries:     fv("inp-curries"),
//     meal_types:      fc("#meal-types .chip"),
//     eating_window:   fv("eat-window-val"),

//     // ── Weekend eating rule ──
//     weekend_eating_rule:        werEnabled,
//     weekend_eating_days:        werDays.length    ? werDays.join(", ")    : "-",
//     weekend_eating_rule_type:   werRule.length    ? werRule.join(", ")    : "-",
//     weekend_eating_custom_rule: werCustom         || "-",
//     weekend_eating_repeat_days: werRepeatDays.length ? werRepeatDays.join(", ") : "-",

//     // ── Food preferences — MSDD dropdowns ──
//     morning_drinks:  fm("msdd-drinks"),
//     nuts:            fm("msdd-nuts"),
//     seeds:           fm("msdd-seeds"),
//     fruits:          fm("msdd-fruits"),
//     vegetables:      fm("msdd-veggies"),
//     sprouts:         fm("msdd-sprouts"),
//     milkshakes:      fm("msdd-milkshakes"),
//     smoothies:       fm("msdd-smoothies"),
//     porridge_malt:   fm("msdd-porridge"),
//     breakfast:       fm("msdd-breakfast"),
//     chutney:         fm("msdd-chutney"),
//     powders_ghee:    fm("msdd-powders"),
//     non_veg:         fm("msdd-nonveg"),
//     rice:            fm("msdd-rice"),
//     millets_grains:  fm("msdd-millets"),

//     // ── Symptoms & final notes ──
//     symptoms:         fc("#symptoms-group .chip"),
//     food_dislikes:    fv("inp-dislikes"),
//     comments:         fv("inp-comments"),
//     whatsapp_consent: fb("consent-wa"),
//   };
// }



// // ════════════════════════════════════════════════════════════════════════════
// //  saveAssessmentData(uid)
// //  Writes all assessment fields + metadata to Firestore under the user's UID.
// //
// //  Firestore structure:
// //    users/{uid}/profile          — name, email, phone
// //    users/{uid}/assessment/current — full assessment snapshot
// //    users/{uid}/progress         — goals, BMI, body fat, timestamps
// //
// //  Also writes to legacy submissions/{submissionId} for admin compatibility.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveAssessmentData(uid, submissionId) {
//   if (!uid) {
//     console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
//     return;
//   }

//   const data = collectFormData();
//   const now  = serverTimestamp();

//   try {
//     // 1. Profile document (quick lookup fields)
//     await setDoc(
//       doc(db, "users", uid, "profile", "info"),
//       {
//         name:      data.name,
//         email:     data.email || auth.currentUser?.email || "",
//         phone:     data.phone,
//         updatedAt: now,
//       },
//       { merge: true }
//     );

//     // 2. Full assessment snapshot (overwrites on each save)
//     await setDoc(
//       doc(db, "users", uid, "assessment", "current"),
//       {
//         ...data,
//         uid,
//         submissionId: submissionId || "",
//         savedAt: now,
//       }
//     );

//     // 3. Progress / goal metrics document
//     await setDoc(
//       doc(db, "users", uid, "progress", "latest"),
//       {
//         bmi:              data.bmi,
//         bmi_category:     data.bmi_category,
//         body_fat:         data.body_fat,
//         ideal_weight:     data.ideal_weight,
//         goal_direction:   data.goal_direction,
//         goal_calories:    data.goal_calories,
//         maintenance_calories: data.maintenance_calories,
//         bmr:              data.bmr,
//         recordedAt:       now,
//       },
//       { merge: true }
//     );

//     console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
//   } catch (err) {
//     console.error("[NP Firebase] saveAssessmentData error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loadAssessmentData(uid)
// //  Reads users/{uid}/assessment/current and restores the form.
// //  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// // ════════════════════════════════════════════════════════════════════════════

// async function loadAssessmentData(uid) {
//   let data = null;

//   if (uid) {
//     try {
//       const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
//       if (snap.exists()) {
//         data = snap.data();
//         console.info("[NP Firebase] Assessment loaded from Firestore.");
//       }
//     } catch (err) {
//       console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
//     }
//   }

//   // Fall back to localStorage draft
//   if (!data) {
//     try {
//       const raw = localStorage.getItem("nutriplan_ls_draft");
//       if (raw) data = JSON.parse(raw);
//       if (data) console.info("[NP Firebase] Assessment loaded from localStorage draft.");
//     } catch (_) {}
//   }

//   if (!data) return; // Nothing to restore

//   // ── Restore simple text/number/select fields ──
//   const set = (id, val) => {
//     const el = document.getElementById(id);
//     if (el && val !== undefined && val !== null && val !== "") el.value = val;
//   };

//   set("inp-name",     data.name);
//   set("inp-age",      data.age);
//   set("inp-phone",    data.phone);
//   set("inp-email",    data.email);
//   set("inp-allergies",data.allergies);
//   set("inp-dislikes", data.food_dislikes);
//   set("inp-comments", data.comments);
//   set("inp-curries",  data.num_curries);
//   set("eat-window-val", data.eating_window);

//   if (data.height) {
//     set("inp-height",    data.height);
//     set("inp-height-cm", Math.round(data.height));
//   }
//   set("inp-weight",   data.weight);
//   set("inp-preg",     data.pregnancy_status);

//   // Measurements
//   ["waist", "neck", "hip"].forEach((m) => {
//     const val = data[m];
//     if (!val) return;
//     const raw = document.getElementById(m + "-raw-input");
//     const hid = document.getElementById("inp-" + m);
//     if (raw) raw.value = val;
//     if (hid) hid.value = val;
//   });

//   // Gender (triggers female row visibility)
//   if (data.gender) {
//     set("inp-gender", data.gender);
//     const femRow = document.getElementById("female-extra-row");
//     if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
//   }

//   if (data.activity_level) set("inp-activity", data.activity_level);
//   if (data.diet_preference) set("inp-diet",     data.diet_preference);
//   if (document.getElementById("consent-wa"))
//     document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

//   // ── Restore chip selections ──
//   const restoreChips = (selector, csvString) => {
//     if (!csvString) return;
//     const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
//     document.querySelectorAll(selector).forEach((chip) => {
//       if (active.includes(chip.textContent.trim())) chip.classList.add("active");
//     });
//   };
//   restoreChips("#meal-types .chip",      data.meal_types);
//   restoreChips("#symptoms-group .chip",  data.symptoms);

//   // Eating time chip
//   if (data.eating_window) {
//     document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
//       if (tc.dataset.value === data.eating_window) tc.classList.add("active");
//     });
//   }

//   // ── Restore MSDD dropdowns ──
//   const msddMap = {
//     "msdd-drinks":    data.morning_drinks,
//     "msdd-fruits":    data.fruits,
//     "msdd-veggies":   data.vegetables,
//     "msdd-sprouts":   data.sprouts,
//     "msdd-milkshakes":data.milkshakes,
//     "msdd-smoothies": data.smoothies,
//     "msdd-porridge":  data.porridge_malt,
//     "msdd-breakfast": data.breakfast,
//     "msdd-chutney":   data.chutney,
//     "msdd-powders":   data.powders_ghee,
//     "msdd-nonveg":    data.non_veg,
//     "msdd-rice":      data.rice,
//     "msdd-millets":   data.millets_grains,
//   };
//   Object.entries(msddMap).forEach(([id, csv]) => {
//     if (!csv) return;
//     csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.msddChange === "function") window.msddChange(id);
//   });

//   // Nuts + seeds (stored combined in "nuts_seeds")
//   if (data.nuts_seeds) {
//     data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       ["msdd-nuts", "msdd-seeds"].forEach((id) => {
//         const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//         if (cb) cb.checked = true;
//       });
//     });
//     if (typeof window.msddChange === "function") {
//       window.msddChange("msdd-nuts");
//       window.msddChange("msdd-seeds");
//     }
//   }

//   // ── Restore health conditions ──
//   if (data.health_conditions) {
//     const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
//     conds.forEach((v) => {
//       if (window.selectedConditions) window.selectedConditions.add(v);
//       const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.renderTags === "function") window.renderTags();
//   }

//   // Open hidden sections that were visible
//   ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
//     setTimeout(() => {
//       const el = document.getElementById(id);
//       if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
//     }, i * 100);
//   });

//   console.info("[NP Firebase] Form restored from saved data.");
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveLocalStorageDraft()
// //  Writes a lightweight draft to localStorage for users who skip sign-in.
// //  Called by autoSaveAssessment() when not signed in.
// // ════════════════════════════════════════════════════════════════════════════

// function saveLocalStorageDraft() {
//   try {
//     const data = collectFormData();
//     localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
//   } catch (err) {
//     console.warn("[NP Firebase] localStorage backup error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  AUTO-SAVE LOGIC
// //  When signed in: debounce-saves to Firestore after 5 s of inactivity.
// //  When not signed in: saves to localStorage after 3 s of inactivity.
// //  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// // ════════════════════════════════════════════════════════════════════════════

// let _autoSaveTimer   = null;
// let _autoSaveEnabled = false;

// /** Trigger a debounced auto-save. Call this from form input listeners. */
// function scheduleAutoSave() {
//   if (!_autoSaveEnabled) return;
//   clearTimeout(_autoSaveTimer);

//   const user = auth.currentUser;
//   const delay = user ? 5000 : 3000;

//   _autoSaveTimer = setTimeout(async () => {
//     if (auth.currentUser) {
//       // Auto-save to Firestore
//       await saveAssessmentData(auth.currentUser.uid);
//     } else {
//       // Auto-save to localStorage
//       saveLocalStorageDraft();
//     }
//   }, delay);
// }

// /** Start auto-save listeners on all form inputs. */
// function autoSaveAssessment() {
//   _autoSaveEnabled = true;

//   const attach = () => {
//     document.querySelectorAll("input, select, textarea").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("input",  scheduleAutoSave);
//         el.addEventListener("change", scheduleAutoSave);
//       }
//     });
//     // Chips and toggle buttons
//     document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
//       }
//     });
//   };

//   attach();
//   // Re-attach after any dynamically rendered chips
//   new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

//   console.info("[NP Firebase] Auto-save enabled.");
// }

// /** Pause auto-save (e.g. while a modal is open or after final submission). */
// function stopAutoSave() {
//   _autoSaveEnabled = false;
//   clearTimeout(_autoSaveTimer);
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  createAccount(email, password)
// //  Creates a new Firebase Auth user and saves assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function createAccount(email, password) {
//   // Validate inputs
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (password.length < 6)
//     return { ok: false, error: "Password must be at least 6 characters." };

//   // Check server-side gates
//   const regOpen = await checkRegistrationOpen();
//   if (!regOpen)
//     return { ok: false, error: "New registrations are currently closed." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This email address is not allowed to register." };

//   try {
//     // Create Firebase Auth account
//     const cred = await createUserWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Persist account metadata
//     await setDoc(
//       doc(db, "accounts", uid),
//       { email, createdAt: serverTimestamp() }
//     );

//     // Save all pending assessment data to Firestore
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     // Store session hints
//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     // Remove localStorage draft — it's now in Firestore
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Account created:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] createAccount error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loginUser(email, password)
// //  Signs the user in and saves any pending assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function loginUser(email, password) {
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (!password)
//     return { ok: false, error: "Enter your password." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This account has been restricted." };

//   try {
//     const cred = await signInWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Save pending assessment data
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Signed in:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] loginUser error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  logoutUser()
// //  Signs out of Firebase Auth and clears session hints.
// // ════════════════════════════════════════════════════════════════════════════

// async function logoutUser() {
//   try {
//     stopAutoSave();
//     await fbSignOut(auth);

//     localStorage.removeItem("nutriplan_uid");
//     localStorage.removeItem("nutriplan_email");
//     localStorage.removeItem("np_auth");

//     console.info("[NP Firebase] Signed out.");
//     return { ok: true };
//   } catch (err) {
//     console.error("[NP Firebase] logoutUser error:", err.message);
//     return { ok: false, error: err.message };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
// //  Mirrors a submission to the "submissions" collection used by admin tools.
// //  Preserved 100% from the original firebase module so nothing breaks.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
//   try {
//     const isEdit = !!(formData._editUid);
//     let resolvedUid = accountUid || null;
//     if (isEdit) {
//       try {
//         const snap = await getDoc(doc(db, "submissions", formData.userId));
//         if (snap.exists() && snap.data().accountUid)
//           resolvedUid = snap.data().accountUid;
//       } catch (_) {}
//     }
//     const entry = {
//       ...formData,
//       accountUid: resolvedUid,
//       forSelf:    forSelf !== false,
//       relName:    relName  || "",
//       relation:   relation || "",
//       ...(isEdit
//         ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
//         : { createdAt: serverTimestamp() }),
//     };
//     delete entry._editUid;
//     await setDoc(
//       doc(db, "submissions", formData.userId),
//       entry,
//       isEdit ? { merge: false } : {}
//     );
//     if (resolvedUid) {
//       await setDoc(
//         doc(db, "accounts", resolvedUid, "profiles", formData.userId),
//         {
//           userId:    formData.userId,
//           name:      formData.name,
//           forSelf:   entry.forSelf,
//           relName:   entry.relName,
//           relation:  entry.relation,
//           timestamp: formData.timestamp,
//         }
//       );
//     }
//   } catch (err) {
//     console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
//   }
// }

// // Expose legacy function under original name so existing inline code still works
// window.saveToFirestore = saveToFirestoreLegacy;


// // ════════════════════════════════════════════════════════════════════════════
// //  onAuthStateChanged — central auth observer
// //  • Signed in  → show avatar with initials, preload saved form data
// //  • Signed out → show "Sign In" button, try loading localStorage draft
// // ════════════════════════════════════════════════════════════════════════════

// onAuthStateChanged(auth, async (user) => {
//   const profileBtn = document.getElementById("nav-profile-btn");
//   const signinBtn  = document.getElementById("nav-signin-btn");
//   const step0Block = document.getElementById("step0-block");

//   if (user) {
//     // Restriction check
//     const allowed = await checkUserNotRestricted(user.email || "");
//     if (!allowed) {
//       await fbSignOut(auth);
//       localStorage.removeItem("np_auth");
//       if (profileBtn) profileBtn.classList.remove("show");
//       if (signinBtn)  signinBtn.classList.add("show");
//       return;
//     }

//     // Show avatar with email initial
//     if (profileBtn) {
//       const initial = (user.email || "U")[0].toUpperCase();
//       profileBtn.textContent = initial;
//       profileBtn.classList.add("show");
//     }
//     if (signinBtn) signinBtn.classList.remove("show");

//     // Start auto-save now that the user is authenticated
//     autoSaveAssessment();

//     // Pre-load any previously saved assessment data into the form
//     // (only if no session draft is present, to avoid overwriting a fresh session)
//     const hasSessionDraft = !!sessionStorage.getItem("nutriplan_draft");
//     if (!hasSessionDraft) {
//       await loadAssessmentData(user.uid);
//     }

//   } else {
//     // Not signed in
//     localStorage.removeItem("np_auth");
//     if (profileBtn) profileBtn.classList.remove("show");
//     if (signinBtn)  signinBtn.classList.add("show");
//     if (step0Block) step0Block.style.display = "none";

//     // Still start auto-save so localStorage draft stays fresh
//     autoSaveAssessment();
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
// //  Re-uses the exact same logic from the original firebase module.
// // ════════════════════════════════════════════════════════════════════════════

// window._regClosed = true;

// onSnapshot(doc(db, "settings", "global"), (snap) => {
//   if (snap.exists()) {
//     const data        = snap.data();
//     const formClosed  = !!data.formSubmissionClosed;
//     const regClosed   = !!data.registrationClosed;

//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(formClosed);

//     window._regClosed = regClosed;

//     // Keep modal tabs in sync if modal is open
//     const modal = document.getElementById("accountModal");
//     if (modal && modal.style.display === "flex") {
//       if (regClosed) {
//         if (typeof window.applyModalRegClosedState === "function")
//           window.applyModalRegClosedState();
//       } else {
//         ["create", "login"].forEach((t) => {
//           const tab = document.getElementById("tab-" + t);
//           if (tab) {
//             tab.classList.remove("active");
//             tab.style.opacity = "";
//             tab.style.cursor  = "";
//             tab.style.pointerEvents = "";
//             tab.title = "";
//           }
//         });
//         document.getElementById("tab-create")?.classList.add("active");
//         const authCreate = document.getElementById("auth-create");
//         const authLogin  = document.getElementById("auth-login");
//         if (authCreate) authCreate.style.display = "block";
//         if (authLogin)  authLogin.style.display  = "none";
//         const notice = document.getElementById("modal-reg-closed-notice");
//         if (notice) notice.style.display = "none";
//       }
//     }
//   } else {
//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(false);
//     window._regClosed = false;
//   }
// }, (err) => {
//   // "Missing or insufficient permissions" is expected when the user is signed out
//   // and Firestore rules require auth for this document.
//   // Fix: set `allow read: if true` on settings/global in your Firestore rules.
//   // We only log unexpected errors (not permission denials).
//   if (err.code !== 'permission-denied') {
//     console.warn("[NP Firebase] settings read error:", err.code, err.message);
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD RESET
// //  Exposed globally so the existing forgotModal can call it.
// // ════════════════════════════════════════════════════════════════════════════

// window.doResetPassword = async function () {
//   const email = document.getElementById("fp-email")?.value?.trim();
//   const errEl = document.getElementById("fp-err");
//   const sucEl = document.getElementById("fp-suc");
//   if (errEl) errEl.style.display = "none";
//   if (sucEl) sucEl.style.display = "none";

//   if (!email || !/\S+@\S+\.\S+/.test(email)) {
//     if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
//     return;
//   }
//   try {
//     await sendPasswordResetEmail(auth, email);
//     if (sucEl) {
//       sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
//       sucEl.style.display = "block";
//     }
//     setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
//   } catch (err) {
//     if (errEl) {
//       errEl.textContent = err.code === "auth/user-not-found"
//         ? "No account found with this email."
//         : friendlyAuthError(err.code);
//       errEl.style.display = "block";
//     }
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
// //  These override the window.createAccount and window.signInExisting
// //  originally defined inline in onboarding.html.
// // ════════════════════════════════════════════════════════════════════════════

// window.createAccount = async function () {
//   const errEl = document.getElementById("acct-err");
//   if (errEl) errEl.style.display = "none";

//   if (window._regClosed) {
//     if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }

//   const email = document.getElementById("acct-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("acct-pass")?.value  ?? "";
//   const pass2 = document.getElementById("acct-pass2")?.value ?? "";

//   if (pass !== pass2) {
//     if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
//     return;
//   }

//   // Disable button while working
//   const btn = document.querySelector("#auth-create .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

//   const result = await createAccount(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// window.signInExisting = async function () {
//   const errEl = document.getElementById("login-err");
//   if (errEl) errEl.style.display = "none";

//   const email = document.getElementById("login-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("login-pass")?.value ?? "";

//   const btn = document.querySelector("#auth-login .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

//   const result = await loginUser(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  SIGN OUT (called by avatar dropdown)
// //  Replaces the doSignOut() function defined in the non-module <script>.
// // ════════════════════════════════════════════════════════════════════════════

// window.doSignOut = async function () {
//   const result = await logoutUser();
//   if (result.ok) {
//     document.getElementById("nav-profile-btn")?.classList.remove("show");
//     const signinBtn = document.getElementById("nav-signin-btn");
//     if (signinBtn) signinBtn.classList.add("show");
//     document.getElementById("avatar-dropdown")?.classList.remove("open");
//     window.location.href = "index.html";
//   } else {
//     localStorage.removeItem("np_auth");
//     window.location.reload();
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  UNREAD MESSAGES CHECK (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// async function checkUnreadMessages(uid) {
//   try {
//     const { collection: col, getDocs: gd, query: q, where: w } =
//       await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
//     const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
//     if (!snap.empty) {
//       const dot = document.getElementById("nav-msg-dot");
//       if (dot) dot.style.display = "inline-block";
//     }
//   } catch (_) {}
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD VISIBILITY TOGGLE
// // ════════════════════════════════════════════════════════════════════════════

// window.togglePw = function (inputId, btn) {
//   const inp = document.getElementById(inputId);
//   if (!inp) return;
//   const isText = inp.type === "text";
//   inp.type  = isText ? "password" : "text";
//   btn.textContent = isText ? "👁" : "🙈";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  ACCOUNT MODAL HELPERS (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// window.proceedToAuth = function () {
//   document.getElementById("acct-step-save").style.display = "none";
//   const user = auth.currentUser;
//   if (user) {
//     (async () => {
//       await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
//       await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
//       if (typeof window.saveLocalProfile === "function")
//         window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
//       const isEdit = !!window._pendingFormData?._editUid;
//       if (typeof window.showAccountDone === "function")
//         window.showAccountDone(
//           "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
//           isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
//         );
//     })();
//   } else {
//     const authStep = document.getElementById("acct-step-auth");
//     if (authStep) authStep.style.display = "block";
//   }
// };

// window.switchAuthTab = function (tab) {
//   if (tab === "create" && window._regClosed) {
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }
//   ["create", "login"].forEach((t) => {
//     document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
//   });
//   const authCreate = document.getElementById("auth-create");
//   const authLogin  = document.getElementById("auth-login");
//   if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
//   if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
// };

// window.skipAccount = function () { window.closeAccountModal(); };
// window.closeAccountModal = function () {
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "none";
//   // Save to localStorage as backup since user skipped sign-in
//   saveLocalStorageDraft();
// };

// window.openAccountModal = function (formData) {
//   window._pendingFormData = formData;
//   window._isForSelf  = window._planForSelf   !== false;
//   window._relName    = window._planOtherName  || "";
//   window._relation   = window._planOtherRelation || "";
//   document.getElementById("acct-step-save").style.display  = "block";
//   document.getElementById("acct-step-auth").style.display  = "none";
//   document.getElementById("acct-step-done").style.display  = "none";
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "flex";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  PUBLIC API — exposed on window.NP_FB for external scripts
// // ════════════════════════════════════════════════════════════════════════════

// window.NP_FB = {
//   auth,
//   db,
//   createAccount,
//   loginUser,
//   logoutUser,
//   saveAssessmentData,
//   loadAssessmentData,
//   autoSaveAssessment,
//   stopAutoSave,
//   saveLocalStorageDraft,
//   collectFormData,
// };

// // Also expose the firebase instances directly (backwards compat)
// window.auth = auth;
// window.db   = db;









// /**
//  * ═══════════════════════════════════════════════════════════════
//  *  firebase.js  —  NutriPlan Firebase Integration Module
//  *  All Firebase Auth + Firestore logic lives here.
//  *  Imported by onboarding.html as a ES module script.
//  * ═══════════════════════════════════════════════════════════════
//  *
//  *  EXPORTS (attached to window for non-module scripts to call):
//  *    window.NP_FB = {
//  *      auth, db,
//  *      createAccount(), loginUser(), logoutUser(),
//  *      saveAssessmentData(), loadAssessmentData(),
//  *      autoSaveAssessment(), stopAutoSave()
//  *    }
//  *
//  *  AUTH FLOW:
//  *    1. On page load  → onAuthStateChanged fires
//  *       • Signed in   → show avatar, preload saved data into form
//  *       • Signed out  → show "Sign In" button, try restoring localStorage draft
//  *
//  *    2. On form submit (submitForm) in onboarding.html:
//  *       • If user NOT signed in → openAccountModal() is called
//  *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
//  *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
//  *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
//  *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
//  *       • If user IS signed in  → saveAssessmentData() called immediately
//  *
//  *  SAVING FLOW (saveAssessmentData):
//  *    Reads all form fields + calculated metrics into one flat object.
//  *    Writes to THREE Firestore paths under the authenticated user's UID:
//  *      • users/{uid}/profile          — name, email, phone, basic info
//  *      • users/{uid}/assessment/current — all assessment fields + calculated data
//  *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
//  *    Also mirrors full submission to the legacy "submissions/{userId}" path
//  *    so admin tools continue to work unchanged.
//  *
//  *  LOADING FLOW (loadAssessmentData):
//  *    Reads users/{uid}/assessment/current from Firestore.
//  *    Restores every form field, chip selections, MSDD dropdowns, etc.
//  *    Falls back to localStorage draft if Firestore has no saved data.
//  *
//  *  AUTO-SAVE LOGIC:
//  *    When a user is signed in, we start a 5-second debounce interval.
//  *    Any form interaction resets the timer. After 5 s of inactivity the
//  *    draft is persisted to Firestore (users/{uid}/assessment/current).
//  *    Auto-save is stopped when the modal is open or the form is submitted.
//  *
//  *  LOCALSTORAGE BACKUP:
//  *    When a user skips account creation OR is not signed in, the draft is
//  *    written to localStorage under "nutriplan_ls_draft".
//  *    On page reload, loadAssessmentData() restores it if no Firestore data
//  *    is available.
//  */

// // ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
// import { initializeApp }
//   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

// import {
//   getAuth,
//   createUserWithEmailAndPassword,
//   signInWithEmailAndPassword,
//   signOut as fbSignOut,
//   onAuthStateChanged,
//   sendPasswordResetEmail,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// import {
//   getFirestore,
//   doc,
//   getDoc,
//   setDoc,
//   collection,
//   serverTimestamp,
//   onSnapshot,
// } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// // ── Firebase project config ──────────────────────────────────────────────────
// const firebaseConfig = {
//   apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
//   authDomain:        "nutriplan-65582.firebaseapp.com",
//   projectId:         "nutriplan-65582",
//   storageBucket:     "nutriplan-65582.firebasestorage.app",
//   messagingSenderId: "851509980462",
//   appId:             "1:851509980462:web:b18af741addba334ca1ebf",
//   measurementId:     "G-2XZZ9YW5FJ",
// };

// // ── Initialise Firebase ───────────────────────────────────────────────────────
// const app  = initializeApp(firebaseConfig);
// const auth = getAuth(app);
// const db   = getFirestore(app);

// // Expose auth + db to window so legacy inline scripts can reference them
// window._fbAuth = auth;
// window._fbDb   = db;


// // ════════════════════════════════════════════════════════════════════════════
// //  HELPERS
// // ════════════════════════════════════════════════════════════════════════════

// /** Map Firebase auth error codes to user-friendly messages. */
// function friendlyAuthError(code) {
//   const map = {
//     "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
//     "auth/invalid-email":          "Please enter a valid email address.",
//     "auth/weak-password":          "Password is too weak — minimum 6 characters.",
//     "auth/user-not-found":         "No account found with that email.",
//     "auth/wrong-password":         "Incorrect password. Please try again.",
//     "auth/invalid-credential":     "Incorrect email or password.",
//     "auth/network-request-failed": "Network error — please check your connection and try again.",
//     "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
//   };
//   return map[code] || "Authentication error. Please try again.";
// }

// /** Check whether a Firestore "restrictedUsers" doc exists for this email. */
// async function checkUserNotRestricted(email) {
//   const docId = email.toLowerCase().replace(/[@.]/g, "_");
//   try {
//     const snap = await getDoc(doc(db, "restrictedUsers", docId));
//     if (snap.exists()) return false;
//   } catch (_) {}
//   return true;
// }

// /** Check whether the global settings allow new registrations. */
// async function checkRegistrationOpen() {
//   try {
//     const snap = await getDoc(doc(db, "settings", "global"));
//     if (snap.exists() && snap.data().registrationClosed === true) return false;
//   } catch (err) {
//     // permission-denied means the rules block unauthenticated reads on settings/global
//     // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
//     if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
//   }
//   return true;
// }

// /** Safely read a DOM element value. */
// const gv = (id) => document.getElementById(id)?.value ?? "";

// /** Read all active chip texts from a CSS selector. */
// const activeChips = (sel) =>
//   [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// // ════════════════════════════════════════════════════════════════════════════
// //  COLLECT FORM DATA
// //  Reads every field on the assessment form into a plain JS object.
// //  Called by saveAssessmentData() and the legacy submitForm().
// // ════════════════════════════════════════════════════════════════════════════

// function collectFormData() {
//   // msddState is defined in the main onboarding.html script
//   const msd = (key) => ((window.msddState || {})[key] || []).join(", ");

//   return {
//     // ── Personal details ──
//     name:             gv("inp-name").trim(),
//     age:              gv("inp-age"),
//     gender:           gv("inp-gender"),
//     phone:            gv("inp-phone"),
//     email:            gv("inp-email"),

//     // ── Body metrics ──
//     height:           gv("inp-height"),
//     weight:           gv("inp-weight"),
//     waist:            gv("inp-waist"),
//     neck:             gv("inp-neck"),
//     hip:              gv("inp-hip"),
//     pregnancy_status: gv("inp-preg"),
//     activity_level:   gv("inp-activity"),

//     // ── Calculated metrics (from _lastCalcData on window) ──
//     // Note: _lastCalcData stores {wt, ht, ...} but not bmi/bfp directly — recompute
//     bmi: (() => {
//       const d = window._lastCalcData;
//       if (!d) return "";
//       return (d.wt / ((d.ht/100) ** 2)).toFixed(1);
//     })(),
//     bmi_category: (() => {
//       const d = window._lastCalcData;
//       if (!d) return "";
//       const b = d.wt / ((d.ht/100) ** 2);
//       return b < 18.5 ? "Underweight" : b < 25 ? "Normal weight" : b < 30 ? "Overweight" : "Obese";
//     })(),
//     body_fat: "",  // recomputed in submitForm from live inputs; not stored in _lastCalcData
//     ideal_weight:         window._lastCalcData?.idealWeight?.toFixed?.(1) ?? "",
//     bmr:                  window._lastCalcData ? Math.round(window._lastCalcData.bmr) : "",
//     maintenance_calories: window._lastCalcData?.maintenance ?? "",
//     goal_direction:       window._lastCalcData?.direction    ?? "",
//     goal_calories: (() => {
//       const d = window._lastCalcData;
//       if (!d) return "";
//       const rate = window._currentGoalRate ?? 0.5;
//       const adj  = rate === 0.25 ? 250 : rate === 1 ? 1000 : 500;
//       return String(d.direction === "loss"
//         ? Math.max(1000, d.maintenance - adj)
//         : d.direction === "gain"
//         ? d.maintenance + adj
//         : d.maintenance);
//     })(),

//     // ── Health conditions ──
//     health_conditions: [...(window.selectedConditions ?? new Set())].join(", "),
//     allergies:         gv("inp-allergies"),

//     // ── Diet preferences ──
//     diet_preference: gv("inp-diet"),
//     meal_types:      activeChips("#meal-types .chip").join(", "),
//     eating_window:   gv("eat-window-val"),
//     num_curries:     gv("inp-curries"),

//     // ── Food preferences (MSDD dropdowns) ──
//     morning_drinks:  msd("msdd-drinks"),
//     nuts_seeds:      [...((window.msddState || {})["msdd-nuts"]  || []),
//                       ...((window.msddState || {})["msdd-seeds"] || [])].join(", "),
//     fruits:          msd("msdd-fruits"),
//     vegetables:      msd("msdd-veggies"),
//     sprouts:         msd("msdd-sprouts"),
//     milkshakes:      msd("msdd-milkshakes"),
//     smoothies:       msd("msdd-smoothies"),
//     porridge_malt:   msd("msdd-porridge"),
//     breakfast:       msd("msdd-breakfast"),
//     chutney:         msd("msdd-chutney"),
//     powders_ghee:    msd("msdd-powders"),
//     non_veg:         msd("msdd-nonveg"),
//     rice:            msd("msdd-rice"),
//     millets_grains:  msd("msdd-millets"),

//     // ── Symptoms & comments ──
//     symptoms:         activeChips("#symptoms-group .chip").join(", "),
//     comments:         gv("inp-comments"),
//     food_dislikes:    gv("inp-dislikes"),
//     whatsapp_consent: document.getElementById("consent-wa")?.checked ? "Yes" : "No",
//   };
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveAssessmentData(uid)
// //  Writes all assessment fields + metadata to Firestore under the user's UID.
// //
// //  Firestore structure:
// //    users/{uid}/profile          — name, email, phone
// //    users/{uid}/assessment/current — full assessment snapshot
// //    users/{uid}/progress         — goals, BMI, body fat, timestamps
// //
// //  Also writes to legacy submissions/{submissionId} for admin compatibility.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveAssessmentData(uid, submissionId) {
//   if (!uid) {
//     console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
//     return;
//   }

//   const data = collectFormData();
//   const now  = serverTimestamp();

//   try {
//     // 1. Profile document (quick lookup fields)
//     await setDoc(
//       doc(db, "users", uid, "profile", "info"),
//       {
//         name:      data.name,
//         email:     data.email || auth.currentUser?.email || "",
//         phone:     data.phone,
//         updatedAt: now,
//       },
//       { merge: true }
//     );

//     // 2. Full assessment snapshot (overwrites on each save)
//     await setDoc(
//       doc(db, "users", uid, "assessment", "current"),
//       {
//         ...data,
//         uid,
//         submissionId: submissionId || "",
//         savedAt: now,
//       }
//     );

//     // 3. Progress / goal metrics document
//     await setDoc(
//       doc(db, "users", uid, "progress", "latest"),
//       {
//         bmi:              data.bmi,
//         bmi_category:     data.bmi_category,
//         body_fat:         data.body_fat,
//         ideal_weight:     data.ideal_weight,
//         goal_direction:   data.goal_direction,
//         goal_calories:    data.goal_calories,
//         maintenance_calories: data.maintenance_calories,
//         bmr:              data.bmr,
//         recordedAt:       now,
//       },
//       { merge: true }
//     );

//     console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
//   } catch (err) {
//     console.error("[NP Firebase] saveAssessmentData error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loadAssessmentData(uid)
// //  Reads users/{uid}/assessment/current and restores the form.
// //  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// // ════════════════════════════════════════════════════════════════════════════

// async function loadAssessmentData(uid) {
//   let data = null;

//   if (uid) {
//     try {
//       const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
//       if (snap.exists()) {
//         data = snap.data();
//         console.info("[NP Firebase] Assessment loaded from Firestore.");
//       }
//     } catch (err) {
//       console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
//     }
//   }

//   // Fall back to localStorage draft
//   if (!data) {
//     try {
//       const raw = localStorage.getItem("nutriplan_ls_draft");
//       if (raw) data = JSON.parse(raw);
//       if (data) console.info("[NP Firebase] Assessment loaded from localStorage draft.");
//     } catch (_) {}
//   }

//   if (!data) return; // Nothing to restore

//   // ── Restore simple text/number/select fields ──
//   const set = (id, val) => {
//     const el = document.getElementById(id);
//     if (el && val !== undefined && val !== null && val !== "") el.value = val;
//   };

//   set("inp-name",     data.name);
//   set("inp-age",      data.age);
//   set("inp-phone",    data.phone);
//   set("inp-email",    data.email);
//   set("inp-allergies",data.allergies);
//   set("inp-dislikes", data.food_dislikes);
//   set("inp-comments", data.comments);
//   set("inp-curries",  data.num_curries);
//   set("eat-window-val", data.eating_window);

//   if (data.height) {
//     set("inp-height",    data.height);
//     set("inp-height-cm", Math.round(data.height));
//   }
//   set("inp-weight",   data.weight);
//   set("inp-preg",     data.pregnancy_status);

//   // Measurements
//   ["waist", "neck", "hip"].forEach((m) => {
//     const val = data[m];
//     if (!val) return;
//     const raw = document.getElementById(m + "-raw-input");
//     const hid = document.getElementById("inp-" + m);
//     if (raw) raw.value = val;
//     if (hid) hid.value = val;
//   });

//   // Gender (triggers female row visibility)
//   if (data.gender) {
//     set("inp-gender", data.gender);
//     const femRow = document.getElementById("female-extra-row");
//     if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
//   }

//   if (data.activity_level) set("inp-activity", data.activity_level);
//   if (data.diet_preference) set("inp-diet",     data.diet_preference);
//   if (document.getElementById("consent-wa"))
//     document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

//   // ── Restore chip selections ──
//   const restoreChips = (selector, csvString) => {
//     if (!csvString) return;
//     const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
//     document.querySelectorAll(selector).forEach((chip) => {
//       if (active.includes(chip.textContent.trim())) chip.classList.add("active");
//     });
//   };
//   restoreChips("#meal-types .chip",      data.meal_types);
//   restoreChips("#symptoms-group .chip",  data.symptoms);

//   // Eating time chip
//   if (data.eating_window) {
//     document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
//       if (tc.dataset.value === data.eating_window) tc.classList.add("active");
//     });
//   }

//   // ── Restore MSDD dropdowns ──
//   const msddMap = {
//     "msdd-drinks":    data.morning_drinks,
//     "msdd-fruits":    data.fruits,
//     "msdd-veggies":   data.vegetables,
//     "msdd-sprouts":   data.sprouts,
//     "msdd-milkshakes":data.milkshakes,
//     "msdd-smoothies": data.smoothies,
//     "msdd-porridge":  data.porridge_malt,
//     "msdd-breakfast": data.breakfast,
//     "msdd-chutney":   data.chutney,
//     "msdd-powders":   data.powders_ghee,
//     "msdd-nonveg":    data.non_veg,
//     "msdd-rice":      data.rice,
//     "msdd-millets":   data.millets_grains,
//   };
//   Object.entries(msddMap).forEach(([id, csv]) => {
//     if (!csv) return;
//     csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.msddChange === "function") window.msddChange(id);
//   });

//   // Nuts + seeds (stored combined in "nuts_seeds")
//   if (data.nuts_seeds) {
//     data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
//       ["msdd-nuts", "msdd-seeds"].forEach((id) => {
//         const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
//         if (cb) cb.checked = true;
//       });
//     });
//     if (typeof window.msddChange === "function") {
//       window.msddChange("msdd-nuts");
//       window.msddChange("msdd-seeds");
//     }
//   }

//   // ── Restore health conditions ──
//   if (data.health_conditions) {
//     const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
//     conds.forEach((v) => {
//       if (window.selectedConditions) window.selectedConditions.add(v);
//       const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
//       if (cb) cb.checked = true;
//     });
//     if (typeof window.renderTags === "function") window.renderTags();
//   }

//   // Open hidden sections that were visible
//   ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
//     setTimeout(() => {
//       const el = document.getElementById(id);
//       if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
//     }, i * 100);
//   });

//   console.info("[NP Firebase] Form restored from saved data.");
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveLocalStorageDraft()
// //  Writes a lightweight draft to localStorage for users who skip sign-in.
// //  Called by autoSaveAssessment() when not signed in.
// // ════════════════════════════════════════════════════════════════════════════

// function saveLocalStorageDraft() {
//   try {
//     const data = collectFormData();
//     localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
//   } catch (err) {
//     console.warn("[NP Firebase] localStorage backup error:", err);
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  AUTO-SAVE LOGIC
// //  When signed in: debounce-saves to Firestore after 5 s of inactivity.
// //  When not signed in: saves to localStorage after 3 s of inactivity.
// //  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// // ════════════════════════════════════════════════════════════════════════════

// let _autoSaveTimer   = null;
// let _autoSaveEnabled = false;

// /** Trigger a debounced auto-save. Call this from form input listeners. */
// function scheduleAutoSave() {
//   if (!_autoSaveEnabled) return;
//   clearTimeout(_autoSaveTimer);

//   const user = auth.currentUser;
//   const delay = user ? 5000 : 3000;

//   _autoSaveTimer = setTimeout(async () => {
//     if (auth.currentUser) {
//       // Auto-save to Firestore
//       await saveAssessmentData(auth.currentUser.uid);
//     } else {
//       // Auto-save to localStorage
//       saveLocalStorageDraft();
//     }
//   }, delay);
// }

// /** Start auto-save listeners on all form inputs. */
// function autoSaveAssessment() {
//   _autoSaveEnabled = true;

//   const attach = () => {
//     document.querySelectorAll("input, select, textarea").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("input",  scheduleAutoSave);
//         el.addEventListener("change", scheduleAutoSave);
//       }
//     });
//     // Chips and toggle buttons
//     document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
//       if (!el.dataset._npAutoSave) {
//         el.dataset._npAutoSave = "1";
//         el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
//       }
//     });
//   };

//   attach();
//   // Re-attach after any dynamically rendered chips
//   new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

//   console.info("[NP Firebase] Auto-save enabled.");
// }

// /** Pause auto-save (e.g. while a modal is open or after final submission). */
// function stopAutoSave() {
//   _autoSaveEnabled = false;
//   clearTimeout(_autoSaveTimer);
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  createAccount(email, password)
// //  Creates a new Firebase Auth user and saves assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function createAccount(email, password) {
//   // Validate inputs
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (password.length < 6)
//     return { ok: false, error: "Password must be at least 6 characters." };

//   // Check server-side gates
//   const regOpen = await checkRegistrationOpen();
//   if (!regOpen)
//     return { ok: false, error: "New registrations are currently closed." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This email address is not allowed to register." };

//   try {
//     // Create Firebase Auth account
//     const cred = await createUserWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Persist account metadata
//     await setDoc(
//       doc(db, "accounts", uid),
//       { email, createdAt: serverTimestamp() }
//     );

//     // Save all pending assessment data to Firestore
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     // Store session hints
//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     // Remove localStorage draft — it's now in Firestore
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Account created:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] createAccount error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  loginUser(email, password)
// //  Signs the user in and saves any pending assessment data.
// // ════════════════════════════════════════════════════════════════════════════

// async function loginUser(email, password) {
//   if (!email || !/\S+@\S+\.\S+/.test(email))
//     return { ok: false, error: "Enter a valid email address." };
//   if (!password)
//     return { ok: false, error: "Enter your password." };

//   const allowed = await checkUserNotRestricted(email);
//   if (!allowed)
//     return { ok: false, error: "This account has been restricted." };

//   try {
//     const cred = await signInWithEmailAndPassword(auth, email, password);
//     const uid  = cred.user.uid;

//     // Save pending assessment data
//     if (window._pendingFormData) {
//       await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
//     }
//     await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

//     localStorage.setItem("nutriplan_uid",   uid);
//     localStorage.setItem("nutriplan_email", email);
//     localStorage.removeItem("nutriplan_ls_draft");

//     console.info("[NP Firebase] Signed in:", email, uid);
//     return { ok: true, uid, email };
//   } catch (err) {
//     console.error("[NP Firebase] loginUser error:", err.code, err.message);
//     return { ok: false, error: friendlyAuthError(err.code) };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  logoutUser()
// //  Signs out of Firebase Auth and clears session hints.
// // ════════════════════════════════════════════════════════════════════════════

// async function logoutUser() {
//   try {
//     stopAutoSave();
//     await fbSignOut(auth);

//     localStorage.removeItem("nutriplan_uid");
//     localStorage.removeItem("nutriplan_email");
//     localStorage.removeItem("np_auth");

//     console.info("[NP Firebase] Signed out.");
//     return { ok: true };
//   } catch (err) {
//     console.error("[NP Firebase] logoutUser error:", err.message);
//     return { ok: false, error: err.message };
//   }
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
// //  Mirrors a submission to the "submissions" collection used by admin tools.
// //  Preserved 100% from the original firebase module so nothing breaks.
// // ════════════════════════════════════════════════════════════════════════════

// async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
//   try {
//     const isEdit = !!(formData._editUid);
//     let resolvedUid = accountUid || null;
//     if (isEdit) {
//       try {
//         const snap = await getDoc(doc(db, "submissions", formData.userId));
//         if (snap.exists() && snap.data().accountUid)
//           resolvedUid = snap.data().accountUid;
//       } catch (_) {}
//     }
//     const entry = {
//       ...formData,
//       accountUid: resolvedUid,
//       forSelf:    forSelf !== false,
//       relName:    relName  || "",
//       relation:   relation || "",
//       ...(isEdit
//         ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
//         : { createdAt: serverTimestamp() }),
//     };
//     delete entry._editUid;
//     await setDoc(
//       doc(db, "submissions", formData.userId),
//       entry,
//       isEdit ? { merge: false } : {}
//     );
//     if (resolvedUid) {
//       await setDoc(
//         doc(db, "accounts", resolvedUid, "profiles", formData.userId),
//         {
//           userId:    formData.userId,
//           name:      formData.name,
//           forSelf:   entry.forSelf,
//           relName:   entry.relName,
//           relation:  entry.relation,
//           timestamp: formData.timestamp,
//         }
//       );
//     }
//   } catch (err) {
//     console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
//   }
// }

// // Expose legacy function under original name so existing inline code still works
// window.saveToFirestore = saveToFirestoreLegacy;


// // ════════════════════════════════════════════════════════════════════════════
// //  onAuthStateChanged — central auth observer
// //  • Signed in  → show avatar with initials, preload saved form data
// //  • Signed out → show "Sign In" button, try loading localStorage draft
// // ════════════════════════════════════════════════════════════════════════════

// onAuthStateChanged(auth, async (user) => {
//   const profileBtn = document.getElementById("nav-profile-btn");
//   const signinBtn  = document.getElementById("nav-signin-btn");
//   const step0Block = document.getElementById("step0-block");

//   if (user) {
//     // Restriction check
//     const allowed = await checkUserNotRestricted(user.email || "");
//     if (!allowed) {
//       await fbSignOut(auth);
//       localStorage.removeItem("np_auth");
//       if (profileBtn) profileBtn.classList.remove("show");
//       if (signinBtn)  signinBtn.classList.add("show");
//       return;
//     }

//     // Show avatar with email initial
//     if (profileBtn) {
//       const initial = (user.email || "U")[0].toUpperCase();
//       profileBtn.textContent = initial;
//       profileBtn.classList.add("show");
//     }
//     if (signinBtn) signinBtn.classList.remove("show");

//     // Start auto-save now that the user is authenticated
//     autoSaveAssessment();

//     // Pre-load any previously saved assessment data into the form
//     // (only if no session draft is present, to avoid overwriting a fresh session)
//     const hasSessionDraft = !!sessionStorage.getItem("nutriplan_draft");
//     if (!hasSessionDraft) {
//       await loadAssessmentData(user.uid);
//     }

//   } else {
//     // Not signed in
//     localStorage.removeItem("np_auth");
//     if (profileBtn) profileBtn.classList.remove("show");
//     if (signinBtn)  signinBtn.classList.add("show");
//     if (step0Block) step0Block.style.display = "none";

//     // Still start auto-save so localStorage draft stays fresh
//     autoSaveAssessment();
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
// //  Re-uses the exact same logic from the original firebase module.
// // ════════════════════════════════════════════════════════════════════════════

// window._regClosed = true;

// onSnapshot(doc(db, "settings", "global"), (snap) => {
//   if (snap.exists()) {
//     const data        = snap.data();
//     const formClosed  = !!data.formSubmissionClosed;
//     const regClosed   = !!data.registrationClosed;

//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(formClosed);

//     window._regClosed = regClosed;

//     // Keep modal tabs in sync if modal is open
//     const modal = document.getElementById("accountModal");
//     if (modal && modal.style.display === "flex") {
//       if (regClosed) {
//         if (typeof window.applyModalRegClosedState === "function")
//           window.applyModalRegClosedState();
//       } else {
//         ["create", "login"].forEach((t) => {
//           const tab = document.getElementById("tab-" + t);
//           if (tab) {
//             tab.classList.remove("active");
//             tab.style.opacity = "";
//             tab.style.cursor  = "";
//             tab.style.pointerEvents = "";
//             tab.title = "";
//           }
//         });
//         document.getElementById("tab-create")?.classList.add("active");
//         const authCreate = document.getElementById("auth-create");
//         const authLogin  = document.getElementById("auth-login");
//         if (authCreate) authCreate.style.display = "block";
//         if (authLogin)  authLogin.style.display  = "none";
//         const notice = document.getElementById("modal-reg-closed-notice");
//         if (notice) notice.style.display = "none";
//       }
//     }
//   } else {
//     if (typeof window.applyFormClosedState === "function")
//       window.applyFormClosedState(false);
//     window._regClosed = false;
//   }
// }, (err) => {
//   // "Missing or insufficient permissions" is expected when the user is signed out
//   // and Firestore rules require auth for this document.
//   // Fix: set `allow read: if true` on settings/global in your Firestore rules.
//   // We only log unexpected errors (not permission denials).
//   if (err.code !== 'permission-denied') {
//     console.warn("[NP Firebase] settings read error:", err.code, err.message);
//   }
// });


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD RESET
// //  Exposed globally so the existing forgotModal can call it.
// // ════════════════════════════════════════════════════════════════════════════

// window.doResetPassword = async function () {
//   const email = document.getElementById("fp-email")?.value?.trim();
//   const errEl = document.getElementById("fp-err");
//   const sucEl = document.getElementById("fp-suc");
//   if (errEl) errEl.style.display = "none";
//   if (sucEl) sucEl.style.display = "none";

//   if (!email || !/\S+@\S+\.\S+/.test(email)) {
//     if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
//     return;
//   }
//   try {
//     await sendPasswordResetEmail(auth, email);
//     if (sucEl) {
//       sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
//       sucEl.style.display = "block";
//     }
//     setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
//   } catch (err) {
//     if (errEl) {
//       errEl.textContent = err.code === "auth/user-not-found"
//         ? "No account found with this email."
//         : friendlyAuthError(err.code);
//       errEl.style.display = "block";
//     }
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
// //  These override the window.createAccount and window.signInExisting
// //  originally defined inline in onboarding.html.
// // ════════════════════════════════════════════════════════════════════════════

// window.createAccount = async function () {
//   const errEl = document.getElementById("acct-err");
//   if (errEl) errEl.style.display = "none";

//   if (window._regClosed) {
//     if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }

//   const email = document.getElementById("acct-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("acct-pass")?.value  ?? "";
//   const pass2 = document.getElementById("acct-pass2")?.value ?? "";

//   if (pass !== pass2) {
//     if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
//     return;
//   }

//   // Disable button while working
//   const btn = document.querySelector("#auth-create .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

//   const result = await createAccount(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// window.signInExisting = async function () {
//   const errEl = document.getElementById("login-err");
//   if (errEl) errEl.style.display = "none";

//   const email = document.getElementById("login-email")?.value?.trim() ?? "";
//   const pass  = document.getElementById("login-pass")?.value ?? "";

//   const btn = document.querySelector("#auth-login .btn-primary");
//   if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

//   const result = await loginUser(email, pass);

//   if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

//   if (!result.ok) {
//     if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
//     return;
//   }

//   // Success — store local profile reference and redirect
//   if (window._pendingFormData) {
//     if (typeof window.saveLocalProfile === "function")
//       window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
//         window._isForSelf, window._relName, window._relation);
//   }
//   window.location.href = "dietplan.html";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  SIGN OUT (called by avatar dropdown)
// //  Replaces the doSignOut() function defined in the non-module <script>.
// // ════════════════════════════════════════════════════════════════════════════

// window.doSignOut = async function () {
//   const result = await logoutUser();
//   if (result.ok) {
//     document.getElementById("nav-profile-btn")?.classList.remove("show");
//     const signinBtn = document.getElementById("nav-signin-btn");
//     if (signinBtn) signinBtn.classList.add("show");
//     document.getElementById("avatar-dropdown")?.classList.remove("open");
//     window.location.href = "index.html";
//   } else {
//     localStorage.removeItem("np_auth");
//     window.location.reload();
//   }
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  UNREAD MESSAGES CHECK (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// async function checkUnreadMessages(uid) {
//   try {
//     const { collection: col, getDocs: gd, query: q, where: w } =
//       await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
//     const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
//     if (!snap.empty) {
//       const dot = document.getElementById("nav-msg-dot");
//       if (dot) dot.style.display = "inline-block";
//     }
//   } catch (_) {}
// }


// // ════════════════════════════════════════════════════════════════════════════
// //  PASSWORD VISIBILITY TOGGLE
// // ════════════════════════════════════════════════════════════════════════════

// window.togglePw = function (inputId, btn) {
//   const inp = document.getElementById(inputId);
//   if (!inp) return;
//   const isText = inp.type === "text";
//   inp.type  = isText ? "password" : "text";
//   btn.textContent = isText ? "👁" : "🙈";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  ACCOUNT MODAL HELPERS (unchanged from original)
// // ════════════════════════════════════════════════════════════════════════════

// window.proceedToAuth = function () {
//   document.getElementById("acct-step-save").style.display = "none";
//   const user = auth.currentUser;
//   if (user) {
//     (async () => {
//       await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
//       await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
//       if (typeof window.saveLocalProfile === "function")
//         window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
//       const isEdit = !!window._pendingFormData?._editUid;
//       if (typeof window.showAccountDone === "function")
//         window.showAccountDone(
//           "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
//           isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
//         );
//     })();
//   } else {
//     const authStep = document.getElementById("acct-step-auth");
//     if (authStep) authStep.style.display = "block";
//   }
// };

// window.switchAuthTab = function (tab) {
//   if (tab === "create" && window._regClosed) {
//     if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
//     return;
//   }
//   ["create", "login"].forEach((t) => {
//     document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
//   });
//   const authCreate = document.getElementById("auth-create");
//   const authLogin  = document.getElementById("auth-login");
//   if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
//   if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
// };

// window.skipAccount = function () { window.closeAccountModal(); };
// window.closeAccountModal = function () {
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "none";
//   // Save to localStorage as backup since user skipped sign-in
//   saveLocalStorageDraft();
// };

// window.openAccountModal = function (formData) {
//   window._pendingFormData = formData;
//   window._isForSelf  = window._planForSelf   !== false;
//   window._relName    = window._planOtherName  || "";
//   window._relation   = window._planOtherRelation || "";
//   document.getElementById("acct-step-save").style.display  = "block";
//   document.getElementById("acct-step-auth").style.display  = "none";
//   document.getElementById("acct-step-done").style.display  = "none";
//   const m = document.getElementById("accountModal");
//   if (m) m.style.display = "flex";
// };


// // ════════════════════════════════════════════════════════════════════════════
// //  PUBLIC API — exposed on window.NP_FB for external scripts
// // ════════════════════════════════════════════════════════════════════════════

// window.NP_FB = {
//   auth,
//   db,
//   createAccount,
//   loginUser,
//   logoutUser,
//   saveAssessmentData,
//   loadAssessmentData,
//   autoSaveAssessment,
//   stopAutoSave,
//   saveLocalStorageDraft,
//   collectFormData,
// };

// // Also expose the firebase instances directly (backwards compat)
// window.auth = auth;
// window.db   = db;



















/**
 * ═══════════════════════════════════════════════════════════════
 *  firebase.js  —  NutriPlan Firebase Integration Module
 *  All Firebase Auth + Firestore logic lives here.
 *  Imported by onboarding.html as a ES module script.
 * ═══════════════════════════════════════════════════════════════
 *
 *  EXPORTS (attached to window for non-module scripts to call):
 *    window.NP_FB = {
 *      auth, db,
 *      createAccount(), loginUser(), logoutUser(),
 *      saveAssessmentData(), loadAssessmentData(),
 *      autoSaveAssessment(), stopAutoSave()
 *    }
 *
 *  AUTH FLOW:
 *    1. On page load  → onAuthStateChanged fires
 *       • Signed in   → show avatar, preload saved data into form
 *       • Signed out  → show "Sign In" button, try restoring localStorage draft
 *
 *    2. On form submit (submitForm) in onboarding.html:
 *       • If user NOT signed in → openAccountModal() is called
 *         ├─ "Save My Profile"    → proceedToAuth() → show create/sign-in tabs
 *         ├─ createAccount()      → Firebase email/password signup → saveAssessmentData()
 *         ├─ loginUser()          → Firebase sign-in → saveAssessmentData()
 *         └─ "Continue Without Saving" → skipAccount() → localStorage backup only
 *       • If user IS signed in  → saveAssessmentData() called immediately
 *
 *  SAVING FLOW (saveAssessmentData):
 *    Reads all form fields + calculated metrics into one flat object.
 *    Writes to THREE Firestore paths under the authenticated user's UID:
 *      • users/{uid}/profile          — name, email, phone, basic info
 *      • users/{uid}/assessment/current — all assessment fields + calculated data
 *      • users/{uid}/progress         — goals, BMI, body fat, timestamps
 *    Also mirrors full submission to the legacy "submissions/{userId}" path
 *    so admin tools continue to work unchanged.
 *
 *  LOADING FLOW (loadAssessmentData):
 *    Reads users/{uid}/assessment/current from Firestore.
 *    Restores every form field, chip selections, MSDD dropdowns, etc.
 *    Falls back to localStorage draft if Firestore has no saved data.
 *
 *  AUTO-SAVE LOGIC:
 *    When a user is signed in, we start a 5-second debounce interval.
 *    Any form interaction resets the timer. After 5 s of inactivity the
 *    draft is persisted to Firestore (users/{uid}/assessment/current).
 *    Auto-save is stopped when the modal is open or the form is submitted.
 *
 *  LOCALSTORAGE BACKUP:
 *    When a user skips account creation OR is not signed in, the draft is
 *    written to localStorage under "nutriplan_ls_draft".
 *    On page reload, loadAssessmentData() restores it if no Firestore data
 *    is available.
 */

// ── Firebase SDK imports (CDN, modular v10) ──────────────────────────────────
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  collection,
  serverTimestamp,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";


// ── Firebase project config ──────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyC5U_ZtL6ki_LnOS-L6U0jIkWj3vVny1XQ",
  authDomain:        "nutriplan-65582.firebaseapp.com",
  projectId:         "nutriplan-65582",
  storageBucket:     "nutriplan-65582.firebasestorage.app",
  messagingSenderId: "851509980462",
  appId:             "1:851509980462:web:b18af741addba334ca1ebf",
  measurementId:     "G-2XZZ9YW5FJ",
};

// ── Initialise Firebase ───────────────────────────────────────────────────────
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Expose auth + db to window so legacy inline scripts can reference them
window._fbAuth = auth;
window._fbDb   = db;


// ════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════════════

/** Map Firebase auth error codes to user-friendly messages. */
function friendlyAuthError(code) {
  const map = {
    "auth/email-already-in-use":   "An account with this email already exists. Please sign in instead.",
    "auth/invalid-email":          "Please enter a valid email address.",
    "auth/weak-password":          "Password is too weak — minimum 6 characters.",
    "auth/user-not-found":         "No account found with that email.",
    "auth/wrong-password":         "Incorrect password. Please try again.",
    "auth/invalid-credential":     "Incorrect email or password.",
    "auth/network-request-failed": "Network error — please check your connection and try again.",
    "auth/too-many-requests":      "Too many attempts. Please wait a moment and try again.",
  };
  return map[code] || "Authentication error. Please try again.";
}

/** Check whether a Firestore "restrictedUsers" doc exists for this email. */
async function checkUserNotRestricted(email) {
  const docId = email.toLowerCase().replace(/[@.]/g, "_");
  try {
    const snap = await getDoc(doc(db, "restrictedUsers", docId));
    if (snap.exists()) return false;
  } catch (_) {}
  return true;
}

/** Check whether the global settings allow new registrations. */
async function checkRegistrationOpen() {
  try {
    const snap = await getDoc(doc(db, "settings", "global"));
    if (snap.exists() && snap.data().registrationClosed === true) return false;
  } catch (err) {
    // permission-denied means the rules block unauthenticated reads on settings/global
    // Treat as "open" so users aren't incorrectly blocked — fix rules to allow public read.
    if (err.code !== 'permission-denied') console.warn("[NP Firebase] checkRegistrationOpen:", err.code);
  }
  return true;
}

/** Safely read a DOM element value. */
const gv = (id) => document.getElementById(id)?.value ?? "";

/** Read all active chip texts from a CSS selector. */
const activeChips = (sel) =>
  [...document.querySelectorAll(sel + ".active")].map((c) => c.textContent.trim());


// ════════════════════════════════════════════════════════════════════════════
//  COLLECT FORM DATA
//  Reads every field on the assessment form into a plain JS object.
//  Called by saveAssessmentData() and the legacy submitForm().
// ════════════════════════════════════════════════════════════════════════════

function collectFormData() {
  // Safe field reader — returns "-" if element missing or value empty
  const fv = (id) => { const el = document.getElementById(id); return (el?.value || "").trim() || "-"; };
  const fb = (id) => { const el = document.getElementById(id); return el ? (el.checked ? "Yes" : "No") : "-"; };
  const fc = (sel) => { const r = [...document.querySelectorAll(sel + ".active")].map(c => c.textContent.trim()); return r.length ? r.join(", ") : "-"; };
  const fm = (key) => { const r = ((window.msddState || {})[key] || []); return r.length ? r.join(", ") : "-"; };

  const d   = window._lastCalcData || {};
  const ht  = d.ht  || 0;
  const wt  = d.wt  || 0;
  const bmiNum = ht > 0 ? wt / ((ht / 100) ** 2) : 0;
  const bmiCat = bmiNum < 18.5 ? "Underweight" : bmiNum < 25 ? "Normal" : bmiNum < 30 ? "Overweight" : "Obese";

  const waistVal = parseFloat(document.getElementById("inp-waist")?.value) || 0;
  const neckVal  = parseFloat(document.getElementById("inp-neck")?.value)  || 0;
  const hipVal   = parseFloat(document.getElementById("inp-hip")?.value)   || 0;
  const gender   = document.getElementById("inp-gender")?.value || d.gender || "";

  // Weekend eating rule — build per-day map from werState
  const _werDays = (typeof werState !== "undefined" && werState.days) ? werState.days : {};
  const _werEntries = Object.entries(_werDays).filter(([, d]) => d.rules && d.rules.size > 0);

  const planForSelf = window._planForSelf !== false;

  return {
    // ── IDs & metadata ──
    timestamp: new Date().toISOString(),

    // ── Plan context ──
    plan_for:            planForSelf ? "Self" : "Other",
    plan_other_name:     planForSelf ? "-" : (document.getElementById("plan-other-name")?.value || "-").trim(),
    plan_other_relation: planForSelf ? "-" : (document.getElementById("plan-other-relation")?.value || "-").trim(),

    // ── Personal details ──
    name:   (document.getElementById("inp-name")?.value || "").trim() || "-",
    age:    fv("inp-age"),
    gender: gender || "-",
    phone:  fv("inp-phone"),
    email:  fv("inp-email"),

    // ── Body measurements ──
    height:           ht ? String(ht) : "-",
    height_unit:      (document.querySelector(".hcb-tab.active")?.textContent || "-").trim(),
    weight:           wt ? String(wt) : "-",
    waist:            waistVal ? String(waistVal) : "-",
    neck:             neckVal  ? String(neckVal)  : "-",
    hip:              (gender === "Female" && hipVal) ? String(hipVal) : (gender === "Female" ? "-" : "N/A"),
    pregnancy_status: fv("inp-preg"),
    // Save the human-readable label (e.g. "Sedentary — Little or no exercise…")
    // rather than the raw factor number so admin sees meaningful text.
    activity_level: (() => {
      const sel = document.getElementById("inp-activity");
      if (!sel || !sel.value) return "-";
      const opt = sel.options[sel.selectedIndex];
      return opt ? opt.text.trim() : sel.value;
    })(),
    activity_factor: fv("inp-activity"),  // keep the numeric factor for calculations

    // ── Calculated metrics ──
    bmi:                  bmiNum > 0 ? bmiNum.toFixed(1) : "-",
    bmi_category:         bmiNum > 0 ? bmiCat : "-",
    body_fat: (() => {
      // US Navy body fat formula — requires waist, neck, height (+ hip for females)
      const isFemale = gender === "Female";
      if (waistVal > 0 && neckVal > 0 && ht > 0 && (!isFemale || hipVal > 0)) {
        let bfp = null;
        if (isFemale && (waistVal + hipVal - neckVal) > 0) {
          bfp = (495 / (1.29579 - 0.35004 * Math.log10(waistVal + hipVal - neckVal) + 0.22100 * Math.log10(ht))) - 450;
        } else if (!isFemale && (waistVal - neckVal) > 0) {
          bfp = (495 / (1.0324 - 0.19077 * Math.log10(waistVal - neckVal) + 0.15456 * Math.log10(ht))) - 450;
        }
        if (bfp !== null && bfp > 0 && bfp < 60) return bfp.toFixed(1);
      }
      return "-";
    })(),
    body_fat_category: (() => {
      const isFemale = gender === "Female";
      if (waistVal > 0 && neckVal > 0 && ht > 0 && (!isFemale || hipVal > 0)) {
        let bfp = null;
        if (isFemale && (waistVal + hipVal - neckVal) > 0) {
          bfp = (495 / (1.29579 - 0.35004 * Math.log10(waistVal + hipVal - neckVal) + 0.22100 * Math.log10(ht))) - 450;
        } else if (!isFemale && (waistVal - neckVal) > 0) {
          bfp = (495 / (1.0324 - 0.19077 * Math.log10(waistVal - neckVal) + 0.15456 * Math.log10(ht))) - 450;
        }
        if (bfp !== null && bfp > 0 && bfp < 60) {
          return isFemale
            ? (bfp < 14 ? "Essential Fat" : bfp < 21 ? "Athletic" : bfp < 25 ? "Fitness" : bfp < 32 ? "Average" : "Obese")
            : (bfp < 6  ? "Essential Fat" : bfp < 14 ? "Athletic" : bfp < 18 ? "Fitness" : bfp < 25 ? "Average" : "Obese");
        }
      }
      return "-";
    })(),
    ideal_weight:         d.idealWeight ? d.idealWeight.toFixed(1) : "-",
    current_weight:       wt ? String(wt) : "-",
    weight_to_goal:       d.kgDiff ? d.kgDiff.toFixed(1) + " kg" : "-",
    goal_direction:       d.direction || "-",
    maintenance_calories: d.maintenance ? String(d.maintenance) : "-",
    bmr:                  d.bmr        ? String(Math.round(d.bmr)) : "-",
    goal_calories: (() => {
      if (!d.maintenance) return "-";
      const rate = window._currentGoalRate || 0.5;
      let gc = d.direction === "loss" ? d.maintenance - Math.round(rate * 1000)
             : d.direction === "gain" ? d.maintenance + Math.round(rate * 600)
             : d.maintenance;
      return String(Math.max(1000, gc));
    })(),
    goal_rate_kg_per_week: String(window._currentGoalRate || 0.5),
    timeline_days: (() => {
      if (!d.kgDiff || d.direction === "maintain") return "-";
      return String(Math.round((d.kgDiff / (window._currentGoalRate || 0.5)) * 7));
    })(),
    after_goal_calories: (() => {
      if (!d.idealWeight || !ht || !d.age) return "-";
      const afterBmr = gender === "Female"
        ? (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) - 161
        : (10 * d.idealWeight) + (6.25 * ht) - (5 * d.age) + 5;
      return String(Math.round(afterBmr * (parseFloat(d.activity) || 1.2)));
    })(),

    // ── Health ──
    health_conditions: [...(window.selectedConditions ?? new Set())].join(", ") || "-",
    allergies:         fv("inp-allergies"),

    // ── Diet preferences ──
    diet_preference: fv("inp-diet"),
    num_curries:     fv("inp-curries"),
    meal_types:      fc("#meal-types .chip"),
    eating_window:   fv("eat-window-val"),

    // ── Weekend eating rules (per-day) ──
    // Format: { Mon: { rules: ["Only Veg"], custom: "", repeat: "yes" }, ... }
    // Only days that have at least one rule are saved.
    weekend_eating_rules: _werEntries.length > 0
      ? Object.fromEntries(
          _werEntries.map(([day, d]) => [
            day,
            {
              rules:  [...d.rules],
              custom: d.custom || "",
              repeat: d.repeat || null,
            },
          ])
        )
      : null,

    // ── Food preferences — MSDD dropdowns ──
    morning_drinks:  fm("msdd-drinks"),
    nuts:            fm("msdd-nuts"),
    seeds:           fm("msdd-seeds"),
    fruits:          fm("msdd-fruits"),
    vegetables:      fm("msdd-veggies"),
    sprouts:         fm("msdd-sprouts"),
    milkshakes:      fm("msdd-milkshakes"),
    smoothies:       fm("msdd-smoothies"),
    porridge_malt:   fm("msdd-porridge"),
    breakfast:       fm("msdd-breakfast"),
    chutney:         fm("msdd-chutney"),
    powders_ghee:    fm("msdd-powders"),
    non_veg:         fm("msdd-nonveg"),
    rice:            fm("msdd-rice"),
    millets_grains:  fm("msdd-millets"),

    // ── Symptoms & final notes ──
    symptoms:         fc("#symptoms-group .chip"),
    food_dislikes:    fv("inp-dislikes"),
    comments:         fv("inp-comments"),
    whatsapp_consent: fb("consent-wa"),
  };
}



// ════════════════════════════════════════════════════════════════════════════
//  saveAssessmentData(uid)
//  Writes all assessment fields + metadata to Firestore under the user's UID.
//
//  Firestore structure:
//    users/{uid}/profile          — name, email, phone
//    users/{uid}/assessment/current — full assessment snapshot
//    users/{uid}/progress         — goals, BMI, body fat, timestamps
//
//  Also writes to legacy submissions/{submissionId} for admin compatibility.
// ════════════════════════════════════════════════════════════════════════════

async function saveAssessmentData(uid, submissionId) {
  if (!uid) {
    console.warn("[NP Firebase] saveAssessmentData called without uid — aborting.");
    return;
  }

  const data = collectFormData();
  const now  = serverTimestamp();

  try {
    // 1. Profile document (quick lookup fields)
    await setDoc(
      doc(db, "users", uid, "profile", "info"),
      {
        name:      data.name,
        email:     data.email || auth.currentUser?.email || "",
        phone:     data.phone,
        updatedAt: now,
      },
      { merge: true }
    );

    // 2. Full assessment snapshot (overwrites on each save)
    await setDoc(
  doc(db, "users", uid, "assessment", "current"),
  {
    ...data,
    uid,
    userId:       submissionId || "",
    submissionId: submissionId || "",
    savedAt: now,
  }
);

    // 3. Mirror calculated fields back to submissions/{submissionId} so profile.html
    // can display Generated Results even without fetching assessment/current.
    if (submissionId) {
      try {
        await setDoc(
          doc(db, "submissions", submissionId),
          {
            bmi:                  data.bmi,
            bmi_category:         data.bmi_category,
            body_fat:             data.body_fat,
            body_fat_category:    data.body_fat_category,
            ideal_weight:         data.ideal_weight,
            goal_direction:       data.goal_direction,
            goal_calories:        data.goal_calories,
            maintenance_calories: data.maintenance_calories || "-",
            bmr:                  data.bmr || "-",
            weight_to_goal:       data.weight_to_goal,
            goal_rate_kg_per_week: data.goal_rate_kg_per_week,
            timeline_days:        data.timeline_days,
            after_goal_calories:  data.after_goal_calories,
            activity_factor:      data.activity_factor,
            calcUpdatedAt:        now,
          },
          { merge: true }
        );
      } catch (_) {} // non-fatal: profile.html will fall back to assessment/current
    }

    // 4. Progress / goal metrics document
    await setDoc(
      doc(db, "users", uid, "progress", "latest"),
      {
        bmi:              data.bmi,
        bmi_category:     data.bmi_category,
        body_fat:         data.body_fat,
        ideal_weight:     data.ideal_weight,
        goal_direction:   data.goal_direction,
        goal_calories:    data.goal_calories,
        recordedAt:       now,
      },
      { merge: true }
    );

    // Clear the in-progress localStorage draft — the real data is now in Firestore
    try { localStorage.removeItem("nutriplan_ls_draft"); } catch(_) {}
    console.info("[NP Firebase] Assessment saved to Firestore for uid:", uid);
  } catch (err) {
    console.error("[NP Firebase] saveAssessmentData error:", err);
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  loadAssessmentData(uid)
//  Reads users/{uid}/assessment/current and restores the form.
//  Falls back to localStorage "nutriplan_ls_draft" if Firestore is empty.
// ════════════════════════════════════════════════════════════════════════════

async function loadAssessmentData(uid) {
  let data = null;

  if (uid) {
    try {
      const snap = await getDoc(doc(db, "users", uid, "assessment", "current"));
      if (snap.exists()) {
        data = snap.data();
        console.info("[NP Firebase] Assessment loaded from Firestore.");
      }
    } catch (err) {
      console.warn("[NP Firebase] loadAssessmentData Firestore error:", err);
    }
  }

  if (!data) return; // Nothing to restore — do not fall back to localStorage draft on page load

  // ── Restore simple text/number/select fields ──
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null && val !== "") el.value = val;
  };

  set("inp-name",     data.name);
  set("inp-age",      data.age);
  set("inp-phone",    data.phone);
  set("inp-email",    data.email);
  set("inp-allergies",data.allergies);
  set("inp-dislikes", data.food_dislikes);
  set("inp-comments", data.comments);
  set("inp-curries",  data.num_curries);
  set("eat-window-val", data.eating_window);

  if (data.height) {
    set("inp-height",    data.height);
    set("inp-height-cm", Math.round(data.height));
  }
  set("inp-weight",   data.weight);
  set("inp-preg",     data.pregnancy_status);

  // Measurements
  ["waist", "neck", "hip"].forEach((m) => {
    const val = data[m];
    if (!val) return;
    const raw = document.getElementById(m + "-raw-input");
    const hid = document.getElementById("inp-" + m);
    if (raw) raw.value = val;
    if (hid) hid.value = val;
  });

  // Gender (triggers female row visibility)
  if (data.gender) {
    set("inp-gender", data.gender);
    const femRow = document.getElementById("female-extra-row");
    if (femRow) femRow.style.display = data.gender === "Female" ? "grid" : "none";
  }

  // activity_factor stores the numeric select value; activity_level stores the label (new). Support both.
  if (data.activity_factor && data.activity_factor !== "-") set("inp-activity", data.activity_factor);
  else if (data.activity_level && /^\d/.test(data.activity_level)) set("inp-activity", data.activity_level); // legacy fallback
  if (data.diet_preference) set("inp-diet",     data.diet_preference);
  if (document.getElementById("consent-wa"))
    document.getElementById("consent-wa").checked = data.whatsapp_consent === "Yes";

  // ── Restore chip selections ──
  const restoreChips = (selector, csvString) => {
    if (!csvString) return;
    const active = csvString.split(",").map((s) => s.trim()).filter(Boolean);
    document.querySelectorAll(selector).forEach((chip) => {
      if (active.includes(chip.textContent.trim())) chip.classList.add("active");
    });
  };
  restoreChips("#meal-types .chip",      data.meal_types);
  restoreChips("#symptoms-group .chip",  data.symptoms);

  // Eating time chip
  if (data.eating_window) {
    document.querySelectorAll("#time-window-chips .time-chip").forEach((tc) => {
      if (tc.dataset.value === data.eating_window) tc.classList.add("active");
    });
  }

  // ── Restore Weekend Eating Rule ──
  {
    // ── Backward compatibility: convert old flat fields → new per-day format ──
    let werData = data.weekend_eating_rules; // new format: { Mon: { rules, custom, repeat }, ... }

    if (!werData && data.weekend_eating_rule === "Yes") {
      // Old format: shared rule applied to all selected days
      const oldDays    = (data.weekend_eating_days        && data.weekend_eating_days        !== "-") ? data.weekend_eating_days.split(",").map(s => s.trim()).filter(Boolean)        : [];
      const oldRules   = (data.weekend_eating_rule_type   && data.weekend_eating_rule_type   !== "-") ? data.weekend_eating_rule_type.split(",").map(s => s.trim()).filter(Boolean)   : [];
      const oldCustom  = (data.weekend_eating_custom_rule && data.weekend_eating_custom_rule !== "-") ? data.weekend_eating_custom_rule : "";
      const oldRepeat  = (data.weekend_eating_repeat_days && data.weekend_eating_repeat_days !== "-") ? "yes" : "no";
      const dayAbbr    = { Monday:"Mon", Tuesday:"Tue", Wednesday:"Wed", Thursday:"Thu", Friday:"Fri", Saturday:"Sat", Sunday:"Sun" };

      if (oldDays.length > 0 && oldRules.length > 0) {
        werData = {};
        oldDays.forEach(day => {
          const shortDay = dayAbbr[day] || (day.length > 3 ? day.slice(0, 3) : day);
          werData[shortDay] = { rules: oldRules, custom: oldCustom, repeat: oldRepeat };
        });
      }
    }

    if (werData && typeof werData === "object") {
      // Ensure werState exists (may be in index.html scope)
      if (typeof werState !== "undefined") {
        Object.entries(werData).forEach(([day, dayInfo]) => {
          if (!dayInfo || !dayInfo.rules || dayInfo.rules.length === 0) return;
          werState.days[day] = {
            rules:  new Set(dayInfo.rules),
            custom: dayInfo.custom || "",
            repeat: dayInfo.repeat || null,
          };
          // Mark day chip as having rules (dot indicator)
          if (typeof werUpdateDot === "function") werUpdateDot(day);
        });
      }
    }
  }

  // ── Restore MSDD dropdowns ──
  const msddMap = {
    "msdd-drinks":    data.morning_drinks,
    "msdd-fruits":    data.fruits,
    "msdd-veggies":   data.vegetables,
    "msdd-sprouts":   data.sprouts,
    "msdd-milkshakes":data.milkshakes,
    "msdd-smoothies": data.smoothies,
    "msdd-porridge":  data.porridge_malt,
    "msdd-breakfast": data.breakfast,
    "msdd-chutney":   data.chutney,
    "msdd-powders":   data.powders_ghee,
    "msdd-nonveg":    data.non_veg,
    "msdd-rice":      data.rice,
    "msdd-millets":   data.millets_grains,
  };
  Object.entries(msddMap).forEach(([id, csv]) => {
    if (!csv) return;
    csv.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
      const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
      if (cb) cb.checked = true;
    });
    if (typeof window.msddChange === "function") window.msddChange(id);
  });

  // Nuts + seeds (stored combined in "nuts_seeds")
  if (data.nuts_seeds) {
    data.nuts_seeds.split(",").map((v) => v.trim()).filter(Boolean).forEach((v) => {
      ["msdd-nuts", "msdd-seeds"].forEach((id) => {
        const cb = document.querySelector(`#${id}-list input[value="${v}"]`);
        if (cb) cb.checked = true;
      });
    });
    if (typeof window.msddChange === "function") {
      window.msddChange("msdd-nuts");
      window.msddChange("msdd-seeds");
    }
  }

  // ── Restore health conditions ──
  if (data.health_conditions) {
    const conds = data.health_conditions.split(",").map((v) => v.trim()).filter(Boolean);
    conds.forEach((v) => {
      if (window.selectedConditions) window.selectedConditions.add(v);
      const cb = document.querySelector(`#health-dd-list input[value="${v}"]`);
      if (cb) cb.checked = true;
    });
    if (typeof window.renderTags === "function") window.renderTags();
  }

  // Open hidden sections that were visible
  ["health-section", "prefs-section", "symptoms-section"].forEach((id, i) => {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) { el.style.display = "block"; setTimeout(() => el.classList.add("revealed"), 20); }
    }, i * 100);
  });

  console.info("[NP Firebase] Form restored from saved data.");
}


// ════════════════════════════════════════════════════════════════════════════
//  saveLocalStorageDraft()
//  Writes a lightweight draft to localStorage for users who skip sign-in.
//  Called by autoSaveAssessment() when not signed in.
// ════════════════════════════════════════════════════════════════════════════

function saveLocalStorageDraft() {
  try {
    const data = collectFormData();
    localStorage.setItem("nutriplan_ls_draft", JSON.stringify({ ...data, _savedAt: new Date().toISOString() }));
  } catch (err) {
    console.warn("[NP Firebase] localStorage backup error:", err);
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  AUTO-SAVE LOGIC
//  When signed in: debounce-saves to Firestore after 5 s of inactivity.
//  When not signed in: saves to localStorage after 3 s of inactivity.
//  Attaches listeners to all form inputs once, runs after DOMContentLoaded.
// ════════════════════════════════════════════════════════════════════════════

let _autoSaveTimer   = null;
let _autoSaveEnabled = false;

/** Trigger a debounced auto-save.
 *  Writes only to localStorage (not Firestore) so the in-progress draft
 *  survives an accidental page refresh but never silently overwrites the
 *  user's last submitted profile in Firestore.
 *  Firestore is only written on an explicit form submission.
 */
function scheduleAutoSave() {
  if (!_autoSaveEnabled) return;
  clearTimeout(_autoSaveTimer);

  _autoSaveTimer = setTimeout(() => {
    // Save in-progress draft to localStorage only — never to Firestore here
    saveLocalStorageDraft();
  }, 3000);
}

/** Start auto-save listeners on all form inputs. */
function autoSaveAssessment() {
  _autoSaveEnabled = true;

  const attach = () => {
    document.querySelectorAll("input, select, textarea").forEach((el) => {
      if (!el.dataset._npAutoSave) {
        el.dataset._npAutoSave = "1";
        el.addEventListener("input",  scheduleAutoSave);
        el.addEventListener("change", scheduleAutoSave);
      }
    });
    // Chips and toggle buttons
    document.querySelectorAll(".chip, .time-chip, .yn-btn, .wer-day-chip, .wer-rule-chip").forEach((el) => {
      if (!el.dataset._npAutoSave) {
        el.dataset._npAutoSave = "1";
        el.addEventListener("click", () => setTimeout(scheduleAutoSave, 60));
      }
    });
  };

  attach();
  // Re-attach after any dynamically rendered chips
  new MutationObserver(() => attach()).observe(document.body, { childList: true, subtree: true });

  console.info("[NP Firebase] Auto-save enabled.");
}

/** Pause auto-save (e.g. while a modal is open or after final submission). */
function stopAutoSave() {
  _autoSaveEnabled = false;
  clearTimeout(_autoSaveTimer);
}


// ════════════════════════════════════════════════════════════════════════════
//  createAccount(email, password)
//  Creates a new Firebase Auth user and saves assessment data.
// ════════════════════════════════════════════════════════════════════════════

async function createAccount(email, password) {
  // Validate inputs
  if (!email || !/\S+@\S+\.\S+/.test(email))
    return { ok: false, error: "Enter a valid email address." };
  if (password.length < 6)
    return { ok: false, error: "Password must be at least 6 characters." };

  // Check server-side gates
  const regOpen = await checkRegistrationOpen();
  if (!regOpen)
    return { ok: false, error: "New registrations are currently closed." };

  const allowed = await checkUserNotRestricted(email);
  if (!allowed)
    return { ok: false, error: "This email address is not allowed to register." };

  try {
    // Create Firebase Auth account
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid  = cred.user.uid;

    // Persist account metadata
    await setDoc(
      doc(db, "accounts", uid),
      { email, createdAt: serverTimestamp() }
    );

    // Save all pending assessment data to Firestore
    if (window._pendingFormData) {
      await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
    }
    await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

    // Store session hints
    localStorage.setItem("nutriplan_uid",   uid);
    localStorage.setItem("nutriplan_email", email);
    // Remove localStorage draft — it's now in Firestore
    localStorage.removeItem("nutriplan_ls_draft");

    console.info("[NP Firebase] Account created:", email, uid);
    return { ok: true, uid, email };
  } catch (err) {
    console.error("[NP Firebase] createAccount error:", err.code, err.message);
    return { ok: false, error: friendlyAuthError(err.code) };
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  loginUser(email, password)
//  Signs the user in and saves any pending assessment data.
// ════════════════════════════════════════════════════════════════════════════

async function loginUser(email, password) {
  if (!email || !/\S+@\S+\.\S+/.test(email))
    return { ok: false, error: "Enter a valid email address." };
  if (!password)
    return { ok: false, error: "Enter your password." };

  const allowed = await checkUserNotRestricted(email);
  if (!allowed)
    return { ok: false, error: "This account has been restricted." };

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const uid  = cred.user.uid;

    // Save pending assessment data
    if (window._pendingFormData) {
      await saveToFirestoreLegacy(window._pendingFormData, uid, window._isForSelf, window._relName, window._relation);
    }
    await saveAssessmentData(uid, window._pendingFormData?.userId ?? "");

    localStorage.setItem("nutriplan_uid",   uid);
    localStorage.setItem("nutriplan_email", email);
    localStorage.removeItem("nutriplan_ls_draft");

    console.info("[NP Firebase] Signed in:", email, uid);
    return { ok: true, uid, email };
  } catch (err) {
    console.error("[NP Firebase] loginUser error:", err.code, err.message);
    return { ok: false, error: friendlyAuthError(err.code) };
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  logoutUser()
//  Signs out of Firebase Auth and clears session hints.
// ════════════════════════════════════════════════════════════════════════════

async function logoutUser() {
  try {
    stopAutoSave();
    await fbSignOut(auth);

    localStorage.removeItem("nutriplan_uid");
    localStorage.removeItem("nutriplan_email");
    localStorage.removeItem("np_auth");

    console.info("[NP Firebase] Signed out.");
    return { ok: true };
  } catch (err) {
    console.error("[NP Firebase] logoutUser error:", err.message);
    return { ok: false, error: err.message };
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation)
//  Mirrors a submission to the "submissions" collection used by admin tools.
//  Preserved 100% from the original firebase module so nothing breaks.
// ════════════════════════════════════════════════════════════════════════════

async function saveToFirestoreLegacy(formData, accountUid, forSelf, relName, relation) {
  try {
    const isEdit = !!(formData._editUid);
    let resolvedUid = accountUid || null;
    if (isEdit) {
      try {
        const snap = await getDoc(doc(db, "submissions", formData.userId));
        if (snap.exists() && snap.data().accountUid)
          resolvedUid = snap.data().accountUid;
      } catch (_) {}
    }
    // Calculated result fields - only the calculator should write these.
    // On edit we strip them from the payload so Firestore merge keeps
    // the existing Generated Results values completely untouched.
    const CALC_FIELDS = [
      'bmi','bmi_category','body_fat','body_fat_category',
      'ideal_weight','ideal_range',
      'goal_calories','daily_calories','maintenance_calories',
      'bmr','activity_factor',
      'goal_direction','weight_direction',
      'weight_to_goal','weight_change',
      'goal_rate','goal_rate_kg_per_week',
      'timeline_days','timeline_label',
      'after_goal_calories','goal_statement',
      'calcUpdatedAt',
    ];

    const entry = {
      ...formData,
      accountUid: resolvedUid,
      forSelf:    forSelf !== false,
      relName:    relName  || "",
      relation:   relation || "",
      ...(isEdit
        ? { updatedAt: serverTimestamp(), adminUpdatedAt: null }
        : { createdAt: serverTimestamp() }),
    };
    delete entry._editUid;

    if (isEdit) {
      // Edit: merge into existing doc, never touching calculated fields
      const editPayload = { ...entry };
      CALC_FIELDS.forEach(f => delete editPayload[f]);
      await setDoc(
        doc(db, "submissions", formData.userId),
        editPayload,
        { merge: true }
      );
    } else {
      // New submission: write everything
      await setDoc(
        doc(db, "submissions", formData.userId),
        entry
      );
    }
    if (resolvedUid) {
      await setDoc(
        doc(db, "accounts", resolvedUid, "profiles", formData.userId),
        {
          userId:    formData.userId,
          name:      formData.name,
          forSelf:   entry.forSelf,
          relName:   entry.relName,
          relation:  entry.relation,
          timestamp: formData.timestamp,
        }
      );
    }
  } catch (err) {
    console.warn("[NP Firebase] saveToFirestoreLegacy error:", err);
  }
}

// Expose legacy function under original name so existing inline code still works
window.saveToFirestore = saveToFirestoreLegacy;


// ════════════════════════════════════════════════════════════════════════════
//  onAuthStateChanged — central auth observer
//  • Signed in  → show avatar with initials, preload saved form data
//  • Signed out → show "Sign In" button, try loading localStorage draft
// ════════════════════════════════════════════════════════════════════════════

onAuthStateChanged(auth, async (user) => {
  const profileBtn = document.getElementById("nav-profile-btn");
  const signinBtn  = document.getElementById("nav-signin-btn");
  const step0Block = document.getElementById("step0-block");

  if (user) {
    // Restriction check
    const allowed = await checkUserNotRestricted(user.email || "");
    if (!allowed) {
      await fbSignOut(auth);
      localStorage.removeItem("np_auth");
      if (profileBtn) profileBtn.classList.remove("show");
      if (signinBtn)  signinBtn.classList.add("show");
      return;
    }

    // Show avatar with email initial
    if (profileBtn) {
      const initial = (user.email || "U")[0].toUpperCase();
      profileBtn.textContent = initial;
      profileBtn.classList.add("show");
    }
    if (signinBtn) signinBtn.classList.remove("show");

    // Show auth-gated nav links (Dietplan, Comments, Messages) on any page
    localStorage.setItem("np_auth", "signed-in");
    if (typeof window._updateAuthNavLinks === "function") window._updateAuthNavLinks(true);

    // Start auto-save now that the user is authenticated
    autoSaveAssessment();

    // Show step0 block on the assessment page when user is signed in
    if (step0Block) step0Block.style.display = 'block';

    // Do NOT auto-restore form data on page load / refresh.
    // The assessment form always starts blank when navigating to the page.
    // Data is only restored in two explicit flows:
    //   1. Edit flow — profile.html sets nutriplan_draft with _editUid, restoreDraft() fills the form.
    //   2. Cancel-edit — cancelEditMode() reloads the submitted view from sessionStorage.
    // (loadAssessmentData is intentionally not called here anymore.)

  } else {
    // Not signed in
    localStorage.removeItem("np_auth");
    if (profileBtn) profileBtn.classList.remove("show");
    if (signinBtn)  signinBtn.classList.add("show");
    if (step0Block) step0Block.style.display = "none";
    // Hide auth-gated nav links
    if (typeof window._updateAuthNavLinks === "function") window._updateAuthNavLinks(false);

    // Still start auto-save so localStorage draft stays fresh
    autoSaveAssessment();
  }
});


// ════════════════════════════════════════════════════════════════════════════
//  GLOBAL SETTINGS LISTENER (registrationClosed / formSubmissionClosed)
//  Re-uses the exact same logic from the original firebase module.
// ════════════════════════════════════════════════════════════════════════════

window._regClosed = true;

onSnapshot(doc(db, "settings", "global"), (snap) => {
  if (snap.exists()) {
    const data        = snap.data();
    const formClosed  = !!data.formSubmissionClosed;
    const regClosed   = !!data.registrationClosed;

    if (typeof window.applyFormClosedState === "function")
      window.applyFormClosedState(formClosed);

    window._regClosed = regClosed;

    // Keep modal tabs in sync if modal is open
    const modal = document.getElementById("accountModal");
    if (modal && modal.style.display === "flex") {
      if (regClosed) {
        if (typeof window.applyModalRegClosedState === "function")
          window.applyModalRegClosedState();
      } else {
        ["create", "login"].forEach((t) => {
          const tab = document.getElementById("tab-" + t);
          if (tab) {
            tab.classList.remove("active");
            tab.style.opacity = "";
            tab.style.cursor  = "";
            tab.style.pointerEvents = "";
            tab.title = "";
          }
        });
        document.getElementById("tab-create")?.classList.add("active");
        const authCreate = document.getElementById("auth-create");
        const authLogin  = document.getElementById("auth-login");
        if (authCreate) authCreate.style.display = "block";
        if (authLogin)  authLogin.style.display  = "none";
        const notice = document.getElementById("modal-reg-closed-notice");
        if (notice) notice.style.display = "none";
      }
    }
  } else {
    if (typeof window.applyFormClosedState === "function")
      window.applyFormClosedState(false);
    window._regClosed = false;
  }
}, (err) => {
  // "Missing or insufficient permissions" is expected when the user is signed out
  // and Firestore rules require auth for this document.
  // Fix: set `allow read: if true` on settings/global in your Firestore rules.
  // We only log unexpected errors (not permission denials).
  if (err.code !== 'permission-denied') {
    console.warn("[NP Firebase] settings read error:", err.code, err.message);
  }
});


// ════════════════════════════════════════════════════════════════════════════
//  PASSWORD RESET
//  Exposed globally so the existing forgotModal can call it.
// ════════════════════════════════════════════════════════════════════════════

window.doResetPassword = async function () {
  const email = document.getElementById("fp-email")?.value?.trim();
  const errEl = document.getElementById("fp-err");
  const sucEl = document.getElementById("fp-suc");
  if (errEl) errEl.style.display = "none";
  if (sucEl) sucEl.style.display = "none";

  if (!email || !/\S+@\S+\.\S+/.test(email)) {
    if (errEl) { errEl.textContent = "Enter a valid email address."; errEl.style.display = "block"; }
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    if (sucEl) {
      sucEl.innerHTML = "✅ Reset link sent!<br><span style=\"font-weight:400;font-size:12px;\">Check your inbox and spam folder.</span>";
      sucEl.style.display = "block";
    }
    setTimeout(() => { if (typeof window.closeForgotModal === "function") window.closeForgotModal(); }, 4000);
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.code === "auth/user-not-found"
        ? "No account found with this email."
        : friendlyAuthError(err.code);
      errEl.style.display = "block";
    }
  }
};


// ════════════════════════════════════════════════════════════════════════════
//  MODAL WIRING — createAccount / signInExisting (called by HTML buttons)
//  These override the window.createAccount and window.signInExisting
//  originally defined inline in onboarding.html.
// ════════════════════════════════════════════════════════════════════════════

window.createAccount = async function () {
  const errEl = document.getElementById("acct-err");
  if (errEl) errEl.style.display = "none";

  if (window._regClosed) {
    if (errEl) { errEl.textContent = "New registrations are currently closed."; errEl.style.display = "block"; }
    if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
    return;
  }

  const email = document.getElementById("acct-email")?.value?.trim() ?? "";
  const pass  = document.getElementById("acct-pass")?.value  ?? "";
  const pass2 = document.getElementById("acct-pass2")?.value ?? "";

  if (pass !== pass2) {
    if (errEl) { errEl.textContent = "Passwords do not match."; errEl.style.display = "block"; }
    return;
  }

  // Disable button while working
  const btn = document.querySelector("#auth-create .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }

  const result = await createAccount(email, pass);

  if (btn) { btn.disabled = false; btn.textContent = "Create Account →"; }

  if (!result.ok) {
    if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
    return;
  }

  // Success — store local profile reference and redirect
  if (window._pendingFormData) {
    if (typeof window.saveLocalProfile === "function")
      window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
        window._isForSelf, window._relName, window._relation);
  }
  window.location.href = "dietplan.html";
};


window.signInExisting = async function () {
  const errEl = document.getElementById("login-err");
  if (errEl) errEl.style.display = "none";

  const email = document.getElementById("login-email")?.value?.trim() ?? "";
  const pass  = document.getElementById("login-pass")?.value ?? "";

  const btn = document.querySelector("#auth-login .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Signing in…"; }

  const result = await loginUser(email, pass);

  if (btn) { btn.disabled = false; btn.textContent = "Sign In →"; }

  if (!result.ok) {
    if (errEl) { errEl.textContent = result.error; errEl.style.display = "block"; }
    return;
  }

  // Success — store local profile reference and redirect
  if (window._pendingFormData) {
    if (typeof window.saveLocalProfile === "function")
      window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name,
        window._isForSelf, window._relName, window._relation);
  }
  window.location.href = "dietplan.html";
};


// ════════════════════════════════════════════════════════════════════════════
//  SIGN OUT (called by avatar dropdown)
//  Replaces the doSignOut() function defined in the non-module <script>.
// ════════════════════════════════════════════════════════════════════════════

window.doSignOut = async function () {
  const result = await logoutUser();
  if (result.ok) {
    document.getElementById("nav-profile-btn")?.classList.remove("show");
    const signinBtn = document.getElementById("nav-signin-btn");
    if (signinBtn) signinBtn.classList.add("show");
    document.getElementById("avatar-dropdown")?.classList.remove("open");
    window.location.href = "Dietplan.html";
  } else {
    localStorage.removeItem("np_auth");
    window.location.reload();
  }
};


// ════════════════════════════════════════════════════════════════════════════
//  UNREAD MESSAGES CHECK (unchanged from original)
// ════════════════════════════════════════════════════════════════════════════

async function checkUnreadMessages(uid) {
  try {
    const { collection: col, getDocs: gd, query: q, where: w } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const snap = await gd(q(col(db, "messages", uid, "inbox"), w("read", "==", false)));
    if (!snap.empty) {
      const dot = document.getElementById("nav-msg-dot");
      if (dot) dot.style.display = "inline-block";
    }
  } catch (_) {}
}


// ════════════════════════════════════════════════════════════════════════════
//  PASSWORD VISIBILITY TOGGLE
// ════════════════════════════════════════════════════════════════════════════

window.togglePw = function (inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const isText = inp.type === "text";
  inp.type  = isText ? "password" : "text";
  btn.textContent = isText ? "👁" : "🙈";
};


// ════════════════════════════════════════════════════════════════════════════
//  ACCOUNT MODAL HELPERS (unchanged from original)
// ════════════════════════════════════════════════════════════════════════════

window.proceedToAuth = function () {
  document.getElementById("acct-step-save").style.display = "none";
  const user = auth.currentUser;
  if (user) {
    (async () => {
      await saveToFirestoreLegacy(window._pendingFormData, user.uid, window._isForSelf, window._relName, window._relation);
      await saveAssessmentData(user.uid, window._pendingFormData?.userId ?? "");
      if (typeof window.saveLocalProfile === "function")
        window.saveLocalProfile(window._pendingFormData.userId, window._pendingFormData.name, window._isForSelf, window._relName, window._relation);
      const isEdit = !!window._pendingFormData?._editUid;
      if (typeof window.showAccountDone === "function")
        window.showAccountDone(
          "Profile " + (isEdit ? "Updated! ✅" : "Saved! ✅"),
          isEdit ? "Your profile has been updated." : "Linked to your account (" + user.email + ")."
        );
    })();
  } else {
    const authStep = document.getElementById("acct-step-auth");
    if (authStep) authStep.style.display = "block";
  }
};

window.switchAuthTab = function (tab) {
  if (tab === "create" && window._regClosed) {
    if (typeof window.applyModalRegClosedState === "function") window.applyModalRegClosedState();
    return;
  }
  ["create", "login"].forEach((t) => {
    document.getElementById("tab-" + t)?.classList.toggle("active", t === tab);
  });
  const authCreate = document.getElementById("auth-create");
  const authLogin  = document.getElementById("auth-login");
  if (authCreate) authCreate.style.display = tab === "create" ? "block" : "none";
  if (authLogin)  authLogin.style.display  = tab === "login"  ? "block" : "none";
};

window.skipAccount = function () { window.closeAccountModal(); };
window.closeAccountModal = function () {
  const m = document.getElementById("accountModal");
  if (m) m.style.display = "none";
  // Save to localStorage as backup since user skipped sign-in
  saveLocalStorageDraft();
};

window.openAccountModal = function (formData) {
  window._pendingFormData = formData;
  window._isForSelf  = window._planForSelf   !== false;
  window._relName    = window._planOtherName  || "";
  window._relation   = window._planOtherRelation || "";
  document.getElementById("acct-step-save").style.display  = "block";
  document.getElementById("acct-step-auth").style.display  = "none";
  document.getElementById("acct-step-done").style.display  = "none";
  const m = document.getElementById("accountModal");
  if (m) m.style.display = "flex";
};


// ════════════════════════════════════════════════════════════════════════════
//  PUBLIC API — exposed on window.NP_FB for external scripts
// ════════════════════════════════════════════════════════════════════════════

window.NP_FB = {
  auth,
  db,
  createAccount,
  loginUser,
  logoutUser,
  saveAssessmentData,
  loadAssessmentData,
  autoSaveAssessment,
  stopAutoSave,
  saveLocalStorageDraft,
  collectFormData,
};

// Also expose the firebase instances directly (backwards compat)
window.auth = auth;
window.db   = db;