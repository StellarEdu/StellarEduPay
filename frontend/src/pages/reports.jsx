import Head from "next/head";
import ReportDownload from "../components/ReportDownload";
import { useTranslation } from "react-i18next";

export default function ReportsPage() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("nav.reports")} | {t("app.name")}</title>
      </Head>
      <ReportDownload />
    </>
  );
}
