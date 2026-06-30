export async function parseHtmlReportMultipart(request) {
  const data = await request.file();
  if (!data) {
    throw Object.assign(new Error('No file uploaded'), { statusCode: 400 });
  }
  const buffer = await data.toBuffer();
  const fileName = data.filename || 'report.html';
  const projectId = data.fields?.projectId?.value ? String(data.fields.projectId.value).trim() : '';
  const month = data.fields?.month?.value ? String(data.fields.month.value).trim() : '';
  if (!projectId) {
    throw Object.assign(new Error('projectId is required'), { statusCode: 400 });
  }
  if (!month) {
    throw Object.assign(new Error('month is required'), { statusCode: 400 });
  }
  return { buffer, fileName, mimetype: data.mimetype, projectId, month };
}
