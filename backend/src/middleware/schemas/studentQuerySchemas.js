'use strict';

const Joi = require('joi');

const getAllStudentsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
  class: Joi.string().trim().optional(),
  status: Joi.string().trim().optional(),
  search: Joi.string().trim().optional(),
}).unknown(false);

const exportStudentsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
  class: Joi.string().trim().optional(),
  status: Joi.string().trim().optional(),
  includeDeleted: Joi.string().trim().optional(),
}).unknown(false);

const getStudentFeeHistoryQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  limit: Joi.number().integer().min(1).max(500).optional(),
}).unknown(false);

module.exports = {
  getAllStudentsQuerySchema,
  exportStudentsQuerySchema,
  getStudentFeeHistoryQuerySchema,
};
