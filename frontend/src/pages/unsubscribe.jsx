import Head from "next/head";
import { useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import api from "../services/api";
import { getErrorMessage } from "../utils/errorMessages";
import styles from "../styles/unsubscribe.module.css";

// Issue #1542 — landing page for the unsubscribe link in fee-reminder emails.
// Opening this page never changes anything (email security scanners pre-fetch
// links); the parent must confirm, and can undo straight away.
export default function UnsubscribePage() {
  const router = useRouter();
  const { t } = useTranslation();
  const token = typeof router.query.token === "string" ? router.query.token : "";

  // confirm | working | unsubscribed | resubscribed | error
  const [status, setStatus] = useState("confirm");
  const [student, setStudent] = useState(null);
  const [error, setError] = useState("");

  async function submit(path, nextStatus) {
    setStatus("working");
    setError("");
    try {
      const { data } = await api.post(`/reminders/${path}?token=${encodeURIComponent(token)}`);
      setStudent(data);
      setStatus(nextStatus);
    } catch (err) {
      const body = err.response?.data || {};
      setError(getErrorMessage(body.code, body.error));
      setStatus("error");
    }
  }

  const studentLabel = student ? `${student.name} (ID: ${student.studentId})` : "";

  let content;
  if (!router.isReady) {
    content = null;
  } else if (!token) {
    content = (
      <p>{t("unsubscribe.missingToken", "This unsubscribe link is incomplete. Please use the link from your reminder email.")}</p>
    );
  } else if (status === "unsubscribed") {
    content = (
      <>
        <h1>{t("unsubscribe.doneTitle", "You have been unsubscribed")}</h1>
        <p>
          {t("unsubscribe.doneBody", "You will no longer receive fee payment reminder emails for")}{" "}
          <strong>{studentLabel}</strong>.
        </p>
        <p>{t("unsubscribe.undoPrompt", "Changed your mind?")}</p>
        <button type="button" className="btn btn-secondary" onClick={() => submit("resubscribe", "resubscribed")}>
          {t("unsubscribe.undo", "Resubscribe to reminders")}
        </button>
      </>
    );
  } else if (status === "resubscribed") {
    content = (
      <>
        <h1>{t("unsubscribe.resubscribedTitle", "Reminders turned back on")}</h1>
        <p>
          {t("unsubscribe.resubscribedBody", "You will keep receiving fee payment reminders for")}{" "}
          <strong>{studentLabel}</strong>.
        </p>
      </>
    );
  } else {
    content = (
      <>
        <h1>{t("unsubscribe.title", "Unsubscribe from fee reminders?")}</h1>
        <p>
          {t(
            "unsubscribe.explain",
            "You will stop receiving fee payment reminder emails for this student. Payment receipts and other school notices are not affected, and you can turn reminders back on at any time."
          )}
        </p>
        {status === "error" && <p role="alert" className="error-message">{error}</p>}
        <button
          type="button"
          className="btn btn-primary"
          disabled={status === "working"}
          onClick={() => submit("unsubscribe", "unsubscribed")}
        >
          {status === "working" ? t("unsubscribe.working", "Unsubscribing…") : t("unsubscribe.confirm", "Unsubscribe")}
        </button>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{t("unsubscribe.pageTitle", "Unsubscribe")} | {t("app.name")}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className={styles.wrap}>
        <div className={styles.card}>{content}</div>
      </div>
    </>
  );
}
