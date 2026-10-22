import { useState, useEffect } from 'react';
import { listSchools } from '../services/api';

export default function SchoolSelector({ user }) {
  const [schools, setSchools] = useState([]);
  const [selectedSchool, setSelectedSchool] = useState('');
  const [loading, setLoading] = useState(false);

  const isSuperAdmin = user?.roles?.includes('super_admin');
  const userSchoolId = user?.schoolId;

  useEffect(() => {
    // Load selected school from localStorage
    const stored = localStorage.getItem('selectedSchoolId');
    if (stored) {
      setSelectedSchool(stored);
    } else if (userSchoolId) {
      // School users: lock to their school
      setSelectedSchool(userSchoolId);
      localStorage.setItem('selectedSchoolId', userSchoolId);
    }

    // Super-admins: fetch list of schools
    if (isSuperAdmin) {
      setLoading(true);
      listSchools()
        .then((res) => {
          // GET /api/schools returns a bare array; accept the wrapped shape too.
          const list = Array.isArray(res.data) ? res.data : res.data?.schools ?? [];
          setSchools(list);
          // If no school selected yet, select the first one
          if (!stored && list.length > 0) {
            const firstSchool = list[0].schoolId;
            setSelectedSchool(firstSchool);
            localStorage.setItem('selectedSchoolId', firstSchool);
          }
        })
        .catch((err) => {
          console.error('Failed to load schools:', err);
        })
        .finally(() => setLoading(false));
    }
  }, [isSuperAdmin, userSchoolId]);

  function handleChange(e) {
    const newSchoolId = e.target.value;
    setSelectedSchool(newSchoolId);
    localStorage.setItem('selectedSchoolId', newSchoolId);
    // Reload the page to apply the new school context
    window.location.reload();
  }

  if (!isSuperAdmin) {
    // School users see their school name (read-only)
    const schoolName = schools.find((s) => s.schoolId === userSchoolId)?.name || userSchoolId || 'School';
    return (
      <div style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', color: '#6b7280' }}>
        {schoolName}
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', color: '#6b7280' }}>
        Loading schools...
      </div>
    );
  }

  if (schools.length === 0) {
    return (
      <div style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', color: '#dc2626' }}>
        No schools available. Select a school to continue.
      </div>
    );
  }

  return (
    <select
      value={selectedSchool}
      onChange={handleChange}
      style={{
        padding: '0.5rem 1rem',
        borderRadius: '0.5rem',
        border: '1px solid #e5e7eb',
        fontSize: '0.875rem',
        cursor: 'pointer',
        outline: 'none',
      }}
    >
      <option value="">Select a school</option>
      {schools.map((school) => (
        <option key={school.schoolId} value={school.schoolId}>
          {school.name}
        </option>
      ))}
    </select>
  );
}
