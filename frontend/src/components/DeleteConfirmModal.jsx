import { useTranslation } from "react-i18next";
import ConfirmationModal from "./ConfirmationModal";

export default function DeleteConfirmModal({
  feeStructure,
  studentCount = 0,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  loading = false,
  children,
}) {
  const { t } = useTranslation();

  let bodyDescription = description;
  let modalTitle = title || t("fees.deleteTitle");

  if (!description && feeStructure) {
    bodyDescription = (
      <>
        {t("fees.deleteIntro")}{" "}
        <strong>{feeStructure.className}</strong>.
        {studentCount > 0 && (
          <>
            {" "}{t("fees.deleteAffects")}{" "}
            <strong>
              {t("fees.studentCount", { count: studentCount })}
            </strong>
            .
          </>
        )}{" "}
        {t("fees.deleteCannotUndo")}
      </>
    );
  }

  return (
    <ConfirmationModal
      title={modalTitle}
      description={bodyDescription}
      confirmLabel={confirmLabel || t("actions.delete")}
      cancelLabel={cancelLabel || t("actions.cancel")}
      confirmVariant="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
      loading={loading}
    >
      {children}
    </ConfirmationModal>
  );
}
