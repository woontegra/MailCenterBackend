import { Request, Response, NextFunction } from 'express'

interface RateLimitStore {
  [key: string]: {
    count: number
    resetTime: number
  }
}

const store: RateLimitStore = {}

export function rateLimit(options: { windowMs: number; max: number }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown'
    const now = Date.now()

    if (!store[key] || store[key].resetTime < now) {
      store[key] = {
        count: 1,
        resetTime: now + options.windowMs
      }
      return next()
    }

    store[key].count++

    if (store[key].count > options.max) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later'
      })
    }

    next()
  }
}

export function loginRateLimit() {
  return rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }) // 5 attempts per 15 minutes
}

export function apiRateLimit() {
  return rateLimit({ windowMs: 60 * 1000, max: 100 }) // 100 requests per minute
}
