/** Localized labels for staff offer fee and detail fields. */
export const offerZh = {
  'section.fees': '费用',
  'section.details': '录取详情',
  'form.field.tuition_fee': '学费',
  'form.field.registration_fee': '注册费',
  'form.field.admission_fee': '录取手续费',
  'form.field.accommodation_fee': '住宿费',
  'form.field.exam_assessment_fee': '考试与评估费',
  'form.field.student_services_fee': '学生服务费',
  'form.field.graduation_exit_fee': '毕业与离校费',
  'form.field.other_fees': '其他费用',
  'form.field.other_fees_description': '其他费用说明',
  'form.field.program_duration': '课程时长',
  'form.field.study_mode': '学习方式',
  'form.field.program_start_date': '课程开始日期',
  'form.field.partner_institution': '合作院校',
  'form.field.prepared_by_name': '经办人姓名',
  'form.field.requires_visa_flight': '需要签证和机票费用',
  'form.field.notes': '备注',
} as const

/** Keys accepted by the offer field translator. */
export type OfferFieldKey = keyof typeof offerZh

/** Complete English labels for staff offer fields. */
export const offerEn: Record<OfferFieldKey, string> = {
  'section.fees': 'Fees',
  'section.details': 'Offer details',
  'form.field.tuition_fee': 'Tuition fee',
  'form.field.registration_fee': 'Registration fee',
  'form.field.admission_fee': 'Admission fee',
  'form.field.accommodation_fee': 'Accommodation fee',
  'form.field.exam_assessment_fee': 'Exam and assessment fee',
  'form.field.student_services_fee': 'Student services fee',
  'form.field.graduation_exit_fee': 'Graduation and exit fee',
  'form.field.other_fees': 'Other fees',
  'form.field.other_fees_description': 'Other fees description',
  'form.field.program_duration': 'Program duration',
  'form.field.study_mode': 'Study mode',
  'form.field.program_start_date': 'Program start date',
  'form.field.partner_institution': 'Partner institution',
  'form.field.prepared_by_name': 'Prepared by',
  'form.field.requires_visa_flight': 'Visa and flight fees are required',
  'form.field.notes': 'Notes',
}
